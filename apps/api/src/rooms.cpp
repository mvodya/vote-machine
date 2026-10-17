#include "rooms.hpp"

#include <drogon/drogon.h>

#include <functional>
#include <stdexcept>
#include <string>
#include <utility>

#include "access.hpp"

namespace vote_machine {
namespace {
using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

// Send private JSON without caching
void Send(const Reply& reply, const Json::Value& body,
          drogon::HttpStatusCode status = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  response->addHeader("Cache-Control", "no-store");
  response->addHeader("Referrer-Policy", "no-referrer");
  reply(response);
}

// Send a short error without private details
void Error(const Reply& reply, drogon::HttpStatusCode status,
           const std::string& message) {
  Json::Value body;
  body["error"] = message;
  Send(reply, body, status);
}

// Read a short room name from JSON
bool Name(const drogon::HttpRequestPtr& request, std::string& name,
          bool optional) {
  const auto body = request->getJsonObject();
  // Only JSON objects can contain a room name
  if (!body || !body->isObject()) return false;
  // A new room may use the default name
  if (!body->isMember("name")) return optional;
  // The name must be text
  if (!(*body)["name"].isString()) return false;
  name = (*body)["name"].asString();
  std::size_t characters = 0;
  // Count UTF-8 characters, not bytes
  for (unsigned char value : name) {
    if ((value & 0xc0) != 0x80) ++characters;
  }
  return characters <= 200 && name.find('\0') == std::string::npos;
}

// Read and hash the session key from the request
std::string Session(const drogon::HttpRequestPtr& request) {
  const auto& authorization = request->getHeader("Authorization");
  constexpr std::string_view kPrefix = "Bearer ";
  // Cookies are handled by the web server, not here
  if (!authorization.starts_with(kPrefix)) return "";
  const auto token = authorization.substr(kPrefix.size());
  return IsSecret(token) ? HashSecret(token) : "";
}

// Return public room fields without saved secrets
Json::Value Room(const drogon::orm::Row& row) {
  Json::Value room;
  room["id"] = row["id"].as<std::string>();
  room["name"] = row["name"].as<std::string>();
  room["createdAt"] = row["created_at"].as<std::string>();
  room["revision"] = row["revision"].as<std::string>();
  return room;
}

// Read public fields and format dates in UTC
const std::string kRoomColumns =
    "SELECT id::text, name, "
    "to_char(created_at AT TIME ZONE 'UTC', "
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, revision::text FROM ";

// Hide database and crypto errors from the client
void Unavailable(const Reply& reply) {
  Error(reply, drogon::k503ServiceUnavailable, "Service is unavailable");
}

}  // namespace

// Add room routes and their access checks
void RegisterRoomHandlers(const drogon::orm::DbClientPtr& database,
                          const std::string& encryption_key) {
  // A valid key is needed to store and show admin links
  if (!IsSecret(encryption_key))
    throw std::invalid_argument(
        "ADMIN_LINK_KEY must contain 64 hex characters");
  // Create a room with one admin key
  drogon::app().registerHandler(
      "/api/rooms",
      [database, encryption_key](const drogon::HttpRequestPtr& request,
                                 Reply&& reply) {
        std::string name;
        // Reject bad input before starting SQL
        if (!Name(request, name, true)) {
          Error(reply, drogon::k400BadRequest, "Invalid room name");
          return;
        }
        // Keep the raw key out of database queries
        const auto key = NewSecret();
        database->execSqlAsync(
            kRoomColumns +
                "vm_create_room($1, decode($2, 'hex'), decode($3, 'hex'))",
            [reply, key](const drogon::orm::Result& result) {
              Json::Value body;
              body["room"] = Room(result[0]);
              body["adminToken"] = key;
              Send(reply, body, drogon::k201Created);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            name, HashSecret(key), EncryptSecret(key, encryption_key));
      },
      {drogon::Post});

  // Exchange a link key for a new device session
  drogon::app().registerHandler(
      "/api/rooms/{1}/session",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        const auto json = request->getJsonObject();
        // Both the room ID and link key must be valid
        if (!IsRoomId(id) || !json || !json->isObject() ||
            !(*json)["token"].isString() ||
            !IsSecret((*json)["token"].asString())) {
          Error(reply, drogon::k401Unauthorized, "Admin access required");
          return;
        }
        // Each device gets its own session key
        const auto session = NewSecret();
        database->execSqlAsync(
            kRoomColumns +
                "vm_open_admin_session($1::uuid, decode($2, 'hex'), "
                "decode($3, 'hex'))",
            [reply, session](const drogon::orm::Result& result) {
              // No row means this request has no access
              if (result.empty()) {
                Error(reply, drogon::k401Unauthorized, "Admin access required");
                return;
              }
              Json::Value body;
              body["room"] = Room(result[0]);
              body["sessionToken"] = session;
              Send(reply, body);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            id, HashSecret((*json)["token"].asString()), HashSecret(session));
      },
      {drogon::Post});

  // Show the saved link only to a room admin
  drogon::app().registerHandler(
      "/api/rooms/{1}/admin-link",
      [database, encryption_key](const drogon::HttpRequestPtr& request,
                                 Reply&& reply, const std::string& id) {
        const auto session = Session(request);
        // A room ID alone does not grant access
        if (!IsRoomId(id) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Admin access required");
          return;
        }
        database->execSqlAsync(
            "SELECT encode(admin_secret_cipher, 'hex') AS cipher, "
            "encode(admin_secret_hash, 'hex') AS hash FROM "
            "vm_admin_room($1::uuid, decode($2, 'hex'))",
            [reply, encryption_key](const drogon::orm::Result& result) {
              // No row means this request has no access
              if (result.empty()) {
                Error(reply, drogon::k401Unauthorized, "Admin access required");
                return;
              }
              try {
                Json::Value body;
                // Read the key only after the session check
                const auto key = DecryptSecret(
                    result[0]["cipher"].as<std::string>(), encryption_key);
                // Check that this key belongs to the stored hash
                if (HashSecret(key) != result[0]["hash"].as<std::string>())
                  throw std::runtime_error("Invalid stored link");
                body["adminToken"] = key;
                Send(reply, body);
              } catch (const std::exception&) {
                Unavailable(reply);
              }
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            id, session);
      },
      {drogon::Get});

  // Read or rename a room through its session
  drogon::app().registerHandler(
      "/api/rooms/{1}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        const auto session = Session(request);
        // A room ID alone does not grant access
        if (!IsRoomId(id) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Admin access required");
          return;
        }
        std::string name;
        const bool rename = request->method() == drogon::Patch;
        // Only rename requests need a new name
        if (rename && !Name(request, name, false)) {
          Error(reply, drogon::k400BadRequest, "Invalid room name");
          return;
        }
        // Return public data only after the access check
        const auto success = [reply](const drogon::orm::Result& result) {
          // A missing row means this session has no access
          if (result.empty()) {
            Error(reply, drogon::k401Unauthorized, "Admin access required");
            return;
          }
          Json::Value body;
          body["room"] = Room(result[0]);
          Send(reply, body);
        };
        // Hide database errors from the caller
        const auto failure = [reply](const drogon::orm::DrogonDbException&) {
          Unavailable(reply);
        };
        // SQL checks access and changes the name in one call
        if (rename) {
          database->execSqlAsync(
              kRoomColumns + "vm_rename_room($1::uuid, decode($2, 'hex'), $3)",
              success, failure, id, session, name);
        } else {
          database->execSqlAsync(
              kRoomColumns + "vm_admin_room($1::uuid, decode($2, 'hex'))",
              success, failure, id, session);
        }
      },
      {drogon::Get, drogon::Patch});
}

}  // namespace vote_machine
