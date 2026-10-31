// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#include "assets.hpp"

#include <openssl/crypto.h>

#include <stdexcept>
#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {

// Only trusted servers may finish validated uploads or remove unused objects
bool Worker(const drogon::HttpRequestPtr& request, const Reply& reply,
            const std::string& key) {
  const auto& received = request->getHeader("X-Media-Worker");
  if (!IsSecret(key) || received.size() != key.size() ||
      CRYPTO_memcmp(received.data(), key.data(), key.size()) != 0) {
    Error(reply, drogon::k403Forbidden, "Worker access required");
    return false;
  }
  return true;
}

// Keep the room check and media lookup in one database call
void AdminAsset(const drogon::orm::DbClientPtr& database,
                const drogon::HttpRequestPtr& request, const Reply& reply,
                // Fields follow the database call order
                // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                const std::string& room, const std::string& id,
                const std::string& action) {
  const auto session = Session(request);

  if (!IsRoomId(room) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Admin access required");
    return;
  }

  if (!id.empty() && !IsRoomId(id)) {
    Error(reply, drogon::k404NotFound, "Media not found");
    return;
  }

  Json::Value data(Json::objectValue);
  if (request->method() != drogon::Get) {
    const auto body = request->getJsonObject();
    if (!body || !body->isObject() || HasNull(*body)) {
      Error(reply, drogon::k400BadRequest, "Invalid media request");
      return;
    }
    data = *body;
  }

  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      "SELECT "
      "vm_asset_request($1::uuid,decode($2,'hex'),NULLIF($3,'')::uuid,$4,$5::"
      "jsonb)::text AS response",
      [reply](const drogon::orm::Result& result) {
        DatabaseReply(result, reply);
      },
      [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
      room, session, id, action, Json::writeString(writer, data));
}

}  // namespace

// Media bytes stay in S3, while PostgreSQL controls their access
void RegisterAssetHandlers(const drogon::orm::DbClientPtr& database,
                           const std::string& worker_key) {
  // Fail startup instead of silently disabling trusted uploads
  if (!IsSecret(worker_key))
    throw std::invalid_argument(
        "MEDIA_WORKER_KEY must contain 64 hex characters");
  drogon::app().registerHandler(
      "/api/rooms/{1}/assets",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        AdminAsset(database, request, reply, room, "", "reserve");
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/assets/access",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        AdminAsset(database, request, reply, room, "", "access");
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/rooms/{1}/assets/keepalive",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        AdminAsset(database, request, reply, room, "", "keepalive");
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/assets/{2}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& room, const std::string& id) {
        AdminAsset(database, request, reply, room, id, "get");
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/rooms/{1}/assets/{2}/finish",
      [database, worker_key](
          const drogon::HttpRequestPtr& request, Reply&& reply,
          // Route fields follow the URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          const std::string& room, const std::string& id) {
        if (Worker(request, reply, worker_key))
          AdminAsset(database, request, reply, room, id, "finish");
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/vote/{1}/assets/{2}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& link, const std::string& id) {
        const auto session = Session(request);
        if (!IsRoomId(link) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Link access required");
          return;
        }
        if (!IsRoomId(id)) {
          Error(reply, drogon::k404NotFound, "Media not found");
          return;
        }
        database->execSqlAsync(
            "SELECT "
            "vm_participant_asset($1::uuid,decode($2,'hex'),$3::uuid)::text AS "
            "response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            link, session, id);
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/internal/assets/cleanup",
      [database, worker_key](const drogon::HttpRequestPtr& request,
                             Reply&& reply) {
        if (!Worker(request, reply, worker_key)) return;
        const auto body = request->getJsonObject();
        if (!body || !body->isObject() || HasNull(*body) ||
            !(*body)["action"].isString()) {
          Error(reply, drogon::k400BadRequest, "Invalid worker request");
          return;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT vm_asset_cleanup($1,$2::jsonb)::text AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            (*body)["action"].asString(), Json::writeString(writer, *body));
      },
      {drogon::Post});
}

}  // namespace vote_machine
