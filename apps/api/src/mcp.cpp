// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#include "mcp.hpp"

#include <openssl/crypto.h>

#include <exception>
#include <string>

#include "access.hpp"
#include "http.hpp"
#include "markdown.hpp"

namespace vote_machine {
namespace {

// Use the same media references as browser editor saves
bool PrepareQuestion(Json::Value& question) {
  return question.isObject() && !HasNull(question) &&
         MarkdownReferences(question, question["assetRefs"]);
}

}  // namespace

void RegisterMcpHandlers(const drogon::orm::DbClientPtr& database,
                         const std::string& gateway_key,
                         const std::string& encryption_key) {
  drogon::app().registerHandler(
      "/internal/mcp/{1}",
      [database, gateway_key, encryption_key](
          const drogon::HttpRequestPtr& request, Reply&& reply,
          const std::string& channel) {
        // The ingress strips this header from outside requests
        const auto& key = request->getHeader("X-VM-Gateway");
        if (key.size() != gateway_key.size() ||
            CRYPTO_memcmp(key.data(), gateway_key.data(), gateway_key.size()) !=
                0) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        const auto body = request->getJsonObject();
        if ((channel != "token" && channel != "operation") || !body ||
            !body->isObject() || !(*body)["room"].isString() ||
            !(*body)["action"].isString() || !(*body)["data"].isObject()) {
          Error(reply, drogon::k400BadRequest, "Invalid request");
          return;
        }
        const auto room = (*body)["room"].asString();
        const auto action = (*body)["action"].asString();
        if (!IsRoomId(room) && !(room.empty() && channel == "operation")) {
          Error(reply, drogon::k400BadRequest, "Invalid room");
          return;
        }
        const auto secret = Session(request);
        if (secret.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        if (channel == "token") {
          // Only the settings route can request a new room token
          if (action != "ensure" && action != "rotate") {
            Error(reply, drogon::k400BadRequest, "Invalid action");
            return;
          }
          try {
            const auto candidate = NewSecret();
            database->execSqlAsync(
                "SELECT * FROM vm_room_agent_token($1::uuid,decode($2,'hex'),"
                "$3,decode($4,'hex'),decode($5,'hex'))",
                [reply, encryption_key](const drogon::orm::Result& result) {
                  if (result.empty() || result[0]["status"].as<int>() != 200) {
                    Error(reply, drogon::k401Unauthorized,
                          "Admin access required");
                    return;
                  }
                  try {
                    Json::Value response;
                    response["token"] =
                        DecryptSecret(result[0]["encrypted"].as<std::string>(),
                                      encryption_key);
                    Send(reply, response);
                  } catch (const std::exception&) {
                    Unavailable(reply);
                  }
                },
                [reply](const drogon::orm::DrogonDbException&) {
                  Unavailable(reply);
                },
                room, secret, action, HashSecret(candidate),
                EncryptSecret(candidate, encryption_key));
          } catch (const std::exception&) {
            Unavailable(reply);
          }
          return;
        }
        auto data = (*body)["data"];
        if (channel == "operation" && action == "questions_update" &&
            !PrepareQuestion(data["question"])) {
          Error(reply, drogon::k400BadRequest, "Invalid question or media");
          return;
        }
        if (channel == "operation" && action == "questions_create_batch") {
          auto& questions = data["questions"];
          if (!questions.isArray() || questions.empty() ||
              questions.size() > 20) {
            Error(reply, drogon::k400BadRequest, "Invalid question batch");
            return;
          }
          for (auto& question : questions) {
            if (!PrepareQuestion(question)) {
              Error(reply, drogon::k400BadRequest, "Invalid question or media");
              return;
            }
          }
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_room_agent_operation(NULLIF($1,'')::uuid,decode($2,'hex'),"
            "$3,$4::jsonb)::text AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, secret, action, Json::writeString(writer, data));
      },
      {drogon::Post});
}

}  // namespace vote_machine
