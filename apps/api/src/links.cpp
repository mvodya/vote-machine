#include "links.hpp"

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <stdexcept>
#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {

const std::string kColumns =
    "SELECT authorized, id::text, name, mode, ordinal::text, revision::text, "
    "allow_run_history, "
    "(SELECT count(*)::text FROM voting_sessions visits WHERE "
    "visits.link_id=links.id) AS session_count, "
    "(revoked_at "
    "IS NOT NULL) AS revoked";
const std::string kSecrets =
    ", encode(secret_hash, 'hex') AS hash, encode(secret_cipher, 'hex') AS "
    "cipher";

// Return an access flag even when the link list is empty
const std::string kAccess =
    " RIGHT JOIN (SELECT EXISTS (SELECT 1 FROM "
    "vm_admin_room($1::uuid,decode($2,'hex'))) AS authorized) access ON true";

// Read access from the same database snapshot as the link data
bool Allowed(const drogon::orm::Result& result, const Reply& reply) {
  if (result.empty() || !result[0]["authorized"].as<bool>()) {
    Error(reply, drogon::k401Unauthorized, "Admin access required");
    return false;
  }
  return true;
}

// Count full UTF-8 characters and reject null bytes
bool ValidName(const std::string& name) {
  std::size_t count = 0;
  for (char byte : name) {
    const auto value = static_cast<unsigned char>(byte);
    if ((value & 0xc0) != 0x80) ++count;
  }
  return count <= 200 && name.find('\0') == std::string::npos;
}

// Accept only non-negative page cursors that fit PostgreSQL bigint
bool ValidCursor(const std::string& text) {
  std::int64_t value = 0;
  const auto [end, error] =
      std::from_chars(text.data(), text.data() + text.size(), value);
  return !text.empty() && text[0] != '+' && error == std::errc{} &&
         end == text.data() + text.size() && value >= 0;
}

// Return metadata without hashes or encrypted keys
Json::Value Link(const drogon::orm::Row& row) {
  Json::Value link;
  for (const auto* field : {"id", "name", "mode", "ordinal", "revision"})
    link[field] = row[field].as<std::string>();
  link["revoked"] = row["revoked"].as<bool>();
  link["allowRunHistory"] = row["allow_run_history"].as<bool>();
  link["sessionCount"] = row["session_count"].as<std::string>();
  return link;
}

// Check that an encrypted secret still matches its stored hash
std::string ReadKey(const drogon::orm::Row& row,
                    const std::string& encryption_key) {
  auto key = DecryptSecret(row["cipher"].as<std::string>(), encryption_key);
  if (HashSecret(key) != row["hash"].as<std::string>())
    throw std::runtime_error("Invalid stored link");
  return key;
}

// Return only the current participant's room and link labels
Json::Value Participant(const drogon::orm::Row& row) {
  Json::Value value;
  value["roomId"] = row["room_id"].as<std::string>();
  value["roomName"] = row["room_name"].as<std::string>();
  value["linkId"] = row["link_id"].as<std::string>();
  value["name"] = row["name"].as<std::string>();
  value["mode"] = row["mode"].as<std::string>();
  return value;
}

// Each room action requires an independent admin session
bool Admin(const drogon::HttpRequestPtr& request, const Reply& reply,
           const std::string& room, std::string& session) {
  session = Session(request);
  if (!IsRoomId(room) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Admin access required");
    return false;
  }
  return true;
}

}  // namespace

// Register one-room link management and separate participant sessions
void RegisterLinkHandlers(const drogon::orm::DbClientPtr& database,
                          const std::string& encryption_key) {
  drogon::app().registerHandler(
      "/api/rooms/{1}/links",
      [database, encryption_key](const drogon::HttpRequestPtr& request,
                                 Reply&& reply, const std::string& room) {
        std::string session;
        if (!Admin(request, reply, room, session)) return;
        if (request->method() == drogon::Get) {
          const auto after = request->getParameter("after").empty()
                                 ? "0"
                                 : request->getParameter("after");
          const bool include_secrets = request->getParameter("export") == "1";
          if (!ValidCursor(after)) {
            Error(reply, drogon::k400BadRequest, "Invalid cursor");
            return;
          }
          database->execSqlAsync(
              kColumns + (include_secrets ? kSecrets : "") +
                  " FROM vm_list_voting_links($1::uuid, decode($2,'hex'), "
                  "$3::bigint, 51) AS links" +
                  kAccess,
              [reply, include_secrets,
               encryption_key](const drogon::orm::Result& result) {
                try {
                  if (!Allowed(result, reply)) return;
                  Json::Value body;
                  body["links"] = Json::Value(Json::arrayValue);
                  const auto size =
                      result[0]["id"].isNull()
                          ? 0
                          : std::min<std::size_t>(result.size(), 50);
                  for (std::size_t i = 0; i < size; ++i) {
                    auto link = Link(result[i]);
                    // Revoked links never expose a usable secret
                    if (include_secrets)
                      link["token"] =
                          link["revoked"].as<bool>()
                              ? Json::Value()
                              : Json::Value(ReadKey(result[i], encryption_key));
                    body["links"].append(link);
                  }
                  body["nextCursor"] =
                      result.size() > 50
                          ? Json::Value(result[49]["ordinal"].as<std::string>())
                          : Json::Value();
                  Send(reply, body);
                } catch (const std::exception&) {
                  Unavailable(reply);
                }
              },
              [reply](const drogon::orm::DrogonDbException&) {
                Unavailable(reply);
              },
              room, session, after);
          return;
        }
        const auto input = request->getJsonObject();
        // Validate the whole batch before making any keys or database changes
        if (!input || !input->isObject() || !(*input)["mode"].isString() ||
            !(*input)["names"].isArray() || (*input)["names"].empty() ||
            (*input)["names"].size() > 100) {
          Error(reply, drogon::k400BadRequest, "Invalid batch");
          return;
        }
        const auto mode = (*input)["mode"].asString();
        if (mode != "personal" && mode != "reusable") {
          Error(reply, drogon::k400BadRequest, "Invalid mode");
          return;
        }
        // Only shared links may expose earlier runs
        if (input->isMember("allowRunHistory") &&
            (!(*input)["allowRunHistory"].isBool() ||
             (mode == "personal" && (*input)["allowRunHistory"].asBool()))) {
          Error(reply, drogon::k400BadRequest, "Invalid history setting");
          return;
        }
        for (const auto& name : (*input)["names"])
          if (!name.isString() || !ValidName(name.asString())) {
            Error(reply, drogon::k400BadRequest, "Invalid name");
            return;
          }
        Json::Value batch(Json::arrayValue);
        for (const auto& name : (*input)["names"]) {
          const auto key = NewSecret();
          Json::Value item;
          item["name"] = name;
          item["mode"] = mode;
          item["allowRunHistory"] = (*input)["allowRunHistory"].asBool();
          item["hash"] = HashSecret(key);
          item["cipher"] = EncryptSecret(key, encryption_key);
          batch.append(item);
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            kColumns +
                " FROM vm_add_voting_links($1::uuid, decode($2,'hex'), "
                "$3::jsonb) AS links" +
                kAccess,
            [reply](const drogon::orm::Result& result) {
              if (!Allowed(result, reply)) return;
              Json::Value body;
              body["links"] = Json::Value(Json::arrayValue);
              for (const auto& row : result) body["links"].append(Link(row));
              Send(reply, body, drogon::k201Created);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, Json::writeString(writer, batch));
      },
      {drogon::Get, drogon::Post});

  drogon::app().registerHandler(
      "/api/rooms/{1}/links/{2}",
      [database, encryption_key](
          const drogon::HttpRequestPtr& request,
          // Route fields follow the URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          Reply&& reply, const std::string& room, const std::string& id) {
        std::string session;
        if (!Admin(request, reply, room, session)) return;
        if (!IsRoomId(id)) {
          Error(reply, drogon::k404NotFound, "Link not found");
          return;
        }
        const auto input = request->getJsonObject();
        if (!input || !input->isObject() || !(*input)["action"].isString()) {
          Error(reply, drogon::k400BadRequest, "Invalid action");
          return;
        }
        const auto action = (*input)["action"].asString();
        std::string name;
        if (action == "rename") {
          if (!(*input)["name"].isString() ||
              !ValidName((*input)["name"].asString())) {
            Error(reply, drogon::k400BadRequest, "Invalid name");
            return;
          }
          name = (*input)["name"].asString();
        } else if (action != "revoke" && action != "rotate") {
          Error(reply, drogon::k400BadRequest, "Invalid action");
          return;
        }
        if (input->isMember("allowRunHistory") &&
            (action != "rename" || !(*input)["allowRunHistory"].isBool())) {
          Error(reply, drogon::k400BadRequest, "Invalid history rule");
          return;
        }
        const std::string history =
            input->isMember("allowRunHistory")
                ? ((*input)["allowRunHistory"].asBool() ? "true" : "false")
                : "";
        const auto key = action == "rotate" ? NewSecret() : "";
        database->execSqlAsync(
            kColumns +
                " FROM vm_edit_voting_link($1::uuid, decode($2,'hex'), "
                "$3::uuid, $4, $5, decode($6,'hex'), decode($7,'hex'), "
                "NULLIF($8,'')::boolean) AS "
                "links" +
                kAccess,
            [reply](const drogon::orm::Result& result) {
              if (!Allowed(result, reply)) return;
              if (result[0]["id"].isNull()) {
                Error(reply, drogon::k404NotFound, "Link not found");
                return;
              }
              Json::Value body;
              body["link"] = Link(result[0]);
              Send(reply, body);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, id, action, name, key.empty() ? "" : HashSecret(key),
            key.empty() ? "" : EncryptSecret(key, encryption_key), history);
      },
      {drogon::Patch});

  drogon::app().registerHandler(
      "/api/rooms/{1}/links/{2}/secret",
      [database, encryption_key](
          const drogon::HttpRequestPtr& request,
          // Route fields follow the URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          Reply&& reply, const std::string& room, const std::string& id) {
        std::string session;
        if (!Admin(request, reply, room, session)) return;
        if (!IsRoomId(id)) {
          Error(reply, drogon::k404NotFound, "Link not found");
          return;
        }
        database->execSqlAsync(
            "SELECT authorized, id::text, encode(secret_hash,'hex') AS hash, "
            "encode(secret_cipher,'hex') AS cipher FROM "
            "vm_voting_link_secret($1::uuid, decode($2,'hex'), $3::uuid)" +
                kAccess,
            [reply, encryption_key](const drogon::orm::Result& result) {
              if (!Allowed(result, reply)) return;
              if (result[0]["id"].isNull()) {
                Error(reply, drogon::k404NotFound, "Link not found");
                return;
              }
              try {
                Json::Value body;
                body["token"] = ReadKey(result[0], encryption_key);
                Send(reply, body);
              } catch (const std::exception&) {
                Unavailable(reply);
              }
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, id);
      },
      {drogon::Get});

  drogon::app().registerHandler(
      "/api/vote/{1}/session",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        const auto input = request->getJsonObject();
        if (!IsRoomId(id) || !input || !input->isObject() ||
            !(*input)["token"].isString() ||
            !IsSecret((*input)["token"].asString())) {
          Error(reply, drogon::k401Unauthorized, "Link access required");
          return;
        }
        const auto token = NewSecret();
        const auto authorization = request->getHeader("Authorization");
        const auto prior = authorization.starts_with("Bearer ") &&
                                   IsSecret(authorization.substr(7))
                               ? authorization.substr(7)
                               : std::string();
        database->execSqlAsync(
            "SELECT * FROM vm_exchange_voting_session($1::uuid, "
            "decode($2,'hex'), "
            "decode($3,'hex'),decode($4,'hex'))",
            [reply, token, prior](const drogon::orm::Result& result) {
              if (result.empty()) {
                Error(reply, drogon::k401Unauthorized, "Link access required");
                return;
              }
              Json::Value body;
              body["participant"] = Participant(result[0]);
              body["sessionToken"] =
                  result[0]["reused"].as<bool>() ? prior : token;
              Send(reply, body);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            id, HashSecret((*input)["token"].asString()), HashSecret(token),
            prior.empty() ? std::string() : HashSecret(prior));
      },
      {drogon::Post});

  drogon::app().registerHandler(
      "/api/vote/{1}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        const auto session = Session(request);
        if (!IsRoomId(id) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Link access required");
          return;
        }
        database->execSqlAsync(
            "SELECT * FROM vm_voting_access($1::uuid, decode($2,'hex'))",
            [reply](const drogon::orm::Result& result) {
              if (result.empty()) {
                Error(reply, drogon::k401Unauthorized, "Link access required");
                return;
              }
              Json::Value body;
              body["participant"] = Participant(result[0]);
              Send(reply, body);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            id, session);
      },
      {drogon::Get});
}

}  // namespace vote_machine
