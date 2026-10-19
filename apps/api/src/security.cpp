#include "security.hpp"

#include <openssl/crypto.h>

#include <charconv>
#include <cstdlib>
#include <stdexcept>
#include <string>

#include "access.hpp"
#include "http.hpp"
namespace vote_machine {
namespace {
// Reject disabled or unbounded budgets at startup
int Limit(const char* name, int fallback) {
  const char* source = std::getenv(name);
  if (source == nullptr) return fallback;
  const std::string value(source);
  int parsed = 0;
  const auto [end, error] =
      std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (error != std::errc{} || end != value.data() + value.size() ||
      parsed < 1 || parsed > 100000000)
    throw std::invalid_argument("Invalid request budget");
  return parsed;
}
}  // namespace
// Browser traffic is admitted before the Next.js handler reads its body
void RegisterSecurityHandlers(const drogon::orm::DbClientPtr& database,
                              const std::string& gateway_key) {
  if (!IsSecret(gateway_key))
    throw std::invalid_argument("Invalid API gateway key");
  Json::Value limits;
  limits["network"] = Limit("RATE_NETWORK_PER_MINUTE", 60000);
  limits["create"] = Limit("RATE_CREATE_PER_HOUR", 1000);
  limits["read"] = Limit("RATE_READ_PER_MINUTE", 1200);
  limits["write"] = Limit("RATE_WRITE_PER_MINUTE", 240);
  limits["room"] = Limit("RATE_ROOM_PER_MINUTE", 30000);
  drogon::app().registerHandler(
      "/api/admission",
      [database, gateway_key, limits](const drogon::HttpRequestPtr& request,
                                      Reply&& reply) {
        const auto& supplied = request->getHeader("X-VM-Gateway");
        if (supplied.size() != gateway_key.size() ||
            CRYPTO_memcmp(supplied.data(), gateway_key.data(),
                          gateway_key.size()) != 0) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        const auto body = request->getJsonObject();
        if (!body || !body->isObject() || !(*body)["network"].isString() ||
            !IsSecret((*body)["network"].asString()) ||
            !(*body)["role"].isString() || !(*body)["action"].isString()) {
          Error(reply, drogon::k400BadRequest, "Invalid request context");
          return;
        }
        const auto role = (*body)["role"].asString();
        const auto action = (*body)["action"].asString();
        if ((role != "public" && role != "admin" && role != "vote") ||
            (action != "read" && action != "write" && action != "create")) {
          Error(reply, drogon::k400BadRequest, "Invalid request context");
          return;
        }
        if (!(*body)["identity"].isString() || !(*body)["session"].isString()) {
          Error(reply, drogon::k400BadRequest, "Invalid request context");
          return;
        }
        const auto identity = (*body)["identity"].asString();
        const auto session = (*body)["session"].asString();
        if ((!identity.empty() && !IsRoomId(identity)) ||
            (!session.empty() && !IsSecret(session))) {
          Error(reply, drogon::k400BadRequest, "Invalid request context");
          return;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_request_admission(decode($1,'hex'),NULLIF($2,'')::uuid,decode($"
            "3,'hex'),$4,$5,$6::jsonb)::text AS response",
            [reply](const drogon::orm::Result& result) {
              Json::Value data;
              Json::Reader reader;
              if (result.empty() ||
                  !reader.parse(result[0]["response"].as<std::string>(),
                                data) ||
                  !data["allowed"].isBool()) {
                Unavailable(reply);
                return;
              }
              auto response = drogon::HttpResponse::newHttpJsonResponse(data);
              response->addHeader("Cache-Control", "private, no-store");
              if (!data["allowed"].asBool()) {
                response->setStatusCode(drogon::k429TooManyRequests);
                response->addHeader("Retry-After",
                                    data["retryAfter"].asString());
              }
              reply(response);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            (*body)["network"].asString(), identity, session, role, action,
            Json::writeString(writer, limits));
      },
      {drogon::Post});
}
}  // namespace vote_machine
