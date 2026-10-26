#include <drogon/drogon.h>
#include <drogon/orm/DbClient.h>
#include <openssl/crypto.h>

#include <atomic>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <string_view>

#include "access.hpp"
#include "assets.hpp"
#include "config.hpp"
#include "links.hpp"
#include "live.hpp"
#include "questions.hpp"
#include "results.hpp"
#include "rooms.hpp"
#include "security.hpp"
#include "voting.hpp"

namespace {

using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

// Read a setting without changing the environment
std::string_view ReadEnv(const char* name) {
  const char* value = std::getenv(name);
  return value == nullptr ? "" : value;
}

// Send JSON without caching
drogon::HttpResponsePtr JsonReply(
    const Json::Value& body, drogon::HttpStatusCode status = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  response->addHeader("Cache-Control", "no-store");
  return response;
}

// Check the database and required schema
void CheckDatabase(const drogon::orm::DbClientPtr& database, const Reply& reply,
                   bool hello) {
  database->execSqlAsync(
      hello ? "SELECT $1::text AS message"
            : "SELECT $1::text AS message, "
              "to_regprocedure('public.vm_create_room(text,bytea,bytea)') IS "
              "NOT NULL AND "
              "to_regprocedure('public.vm_add_voting_links(uuid,bytea,jsonb)') "
              "IS "
              "NOT NULL AND "
              "to_regprocedure('public.vm_question_request(uuid,bytea,uuid,"
              "text,jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_asset_request(uuid,bytea,uuid,text,"
              "jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_close_due()') IS NOT NULL AND "
              "to_regprocedure('public.vm_cast_personal(uuid,bytea,uuid,jsonb)'"
              ") IS NOT NULL AND "
              "to_regprocedure('public.vm_participant_journey(uuid,bytea,jsonb)"
              "') IS NOT NULL AND "
              "to_regprocedure('public.vm_store_question(uuid,bytea,uuid,text,"
              "jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_cast_ballot(uuid,uuid,bytea,boolean,"
              "uuid,jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_results(uuid,bytea,boolean,uuid,"
              "jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_event_state(uuid,bytea,boolean)') IS "
              "NOT NULL AND "
              "to_regprocedure('public.vm_question_presence(uuid,bytea,jsonb)')"
              " IS NOT NULL AND "
              "to_regprocedure('public.vm_request_admission(bytea,uuid,bytea,"
              "text,text,jsonb)') IS NOT NULL AND "
              "to_regprocedure('public.vm_delete_room(uuid,bytea,jsonb)') IS "
              "NOT NULL AND "
              "to_regprocedure('public.vm_room_experience(uuid,bytea,boolean,"
              "jsonb)') IS NOT NULL AS "
              "schema_ready",
      [reply, hello](const drogon::orm::Result& result) {
        Json::Value body;
        // The hello route returns the database reply
        if (hello) {
          body["message"] = result[0]["message"].as<std::string>();
          body["database"] = "connected";
        } else if (result[0]["schema_ready"].as<bool>()) {
          body["status"] = "ready";
        } else {
          body["error"] = "Database schema is unavailable";
          reply(JsonReply(body, drogon::k503ServiceUnavailable));
          return;
        }
        reply(JsonReply(body));
      },
      [reply](const drogon::orm::DrogonDbException&) {
        Json::Value body;
        body["error"] = "Database is unavailable";
        reply(JsonReply(body, drogon::k503ServiceUnavailable));
      },
      std::string("Hello world"));
}

}  // namespace

// Set up the server and close database connections on exit
int main() {
  try {
    // Read config
    const auto config = vote_machine::ParseConfig(
        ReadEnv("DATABASE_URL"), ReadEnv("API_PORT"), ReadEnv("DB_POOL_SIZE"));
    // Connect database
    auto database = drogon::orm::DbClient::newPgClient(config.database_url,
                                                       config.pool_size);
    database->setTimeout(3.0);

    // Draining stops new work but lets accepted database commands finish
    auto draining = std::make_shared<std::atomic<bool>>(false);
    drogon::app().registerPreRoutingAdvice(
        [draining](const drogon::HttpRequestPtr& request,
                   drogon::AdviceCallback&& reply,
                   drogon::AdviceChainCallback&& next) {
          const auto& path = request->path();
          if (draining->load() && path != "/health/live" &&
              path != "/health/ready" && path != "/internal/drain") {
            Json::Value body;
            body["error"] = "Service is draining";
            reply(JsonReply(body, drogon::k503ServiceUnavailable));
            return;
          }
          next();
        });

    // Keep process health separate from database health
    drogon::app().registerHandler(
        "/health/live",
        [](const drogon::HttpRequestPtr&, Reply&& reply) {
          Json::Value body;
          body["status"] = "alive";
          reply(JsonReply(body));
        },
        {drogon::Get});
    drogon::app().registerHandler(
        "/health/ready",
        [database, draining](const drogon::HttpRequestPtr&, Reply&& reply) {
          if (draining->load()) {
            Json::Value body;
            body["status"] = "draining";
            reply(JsonReply(body, drogon::k503ServiceUnavailable));
            return;
          }
          CheckDatabase(database, reply, false);
        },
        {drogon::Get});
    drogon::app().registerHandler(
        "/api/hello",
        [database](const drogon::HttpRequestPtr&, Reply&& reply) {
          CheckDatabase(database, reply, true);
        },
        {drogon::Get});

    // Load the link key from the environment
    vote_machine::RegisterRoomHandlers(database,
                                       std::string(ReadEnv("ADMIN_LINK_KEY")));

    vote_machine::RegisterLinkHandlers(database,
                                       std::string(ReadEnv("ADMIN_LINK_KEY")));
    vote_machine::RegisterQuestionHandlers(database);
    vote_machine::RegisterVotingHandlers(database);
    vote_machine::RegisterResultHandlers(database);
    const auto gateway_key = ReadEnv("API_GATEWAY_KEY");
    vote_machine::RegisterSecurityHandlers(
        database,
        gateway_key.empty()
            ? vote_machine::HashSecret("vote-machine:gateway:" +
                                       std::string(ReadEnv("ADMIN_LINK_KEY")))
            : std::string(gateway_key));
    const auto stop_live =
        vote_machine::RegisterLiveHandlers(database, config.database_url);
    vote_machine::RegisterAssetHandlers(
        database, std::string(ReadEnv("MEDIA_WORKER_KEY")));
    const auto drain_key =
        gateway_key.empty()
            ? vote_machine::HashSecret("vote-machine:gateway:" +
                                       std::string(ReadEnv("ADMIN_LINK_KEY")))
            : std::string(gateway_key);
    // Operators retire one replica without logging or exposing its key
    drogon::app().registerHandler(
        "/internal/drain",
        [draining, drain_key, stop_live](const drogon::HttpRequestPtr& request,
                                         Reply&& reply) {
          const auto& supplied = request->getHeader("X-VM-Gateway");
          if (supplied.size() != drain_key.size() ||
              CRYPTO_memcmp(supplied.data(), drain_key.data(),
                            drain_key.size()) != 0) {
            Json::Value body;
            body["error"] = "Access required";
            reply(JsonReply(body, drogon::k401Unauthorized));
            return;
          }
          if (!draining->exchange(true))
            drogon::app().getLoop()->queueInLoop(stop_live);
          Json::Value body;
          body["status"] = "draining";
          reply(JsonReply(body));
        },
        {drogon::Post});

    // Operator metrics contain counts only and require the private gateway key
    drogon::app().registerHandler(
        "/internal/metrics",
        [database, drain_key, pool_size = config.pool_size](
            const drogon::HttpRequestPtr& request, Reply&& reply) {
          const auto& supplied = request->getHeader("X-VM-Gateway");
          if (supplied.size() != drain_key.size() ||
              CRYPTO_memcmp(supplied.data(), drain_key.data(),
                            drain_key.size()) != 0) {
            Json::Value body;
            body["error"] = "Access required";
            reply(JsonReply(body, drogon::k401Unauthorized));
            return;
          }
          database->execSqlAsync(
              "SELECT (SELECT count(*) FROM pg_stat_activity WHERE "
              "datname=current_database()) AS connections, (SELECT count(*) "
              "FROM object_deletions) AS cleanup",
              [reply, pool_size](const drogon::orm::Result& rows) {
                auto response = drogon::HttpResponse::newHttpResponse();
                response->addHeader("Content-Type",
                                    "text/plain; version=0.0.4");
                response->addHeader("Cache-Control", "no-store");
                response->setBody("vm_database_connections " +
                                  rows[0]["connections"].as<std::string>() +
                                  "\nvm_api_pool_limit " +
                                  std::to_string(pool_size) +
                                  "\nvm_object_cleanup_pending " +
                                  rows[0]["cleanup"].as<std::string>() + "\n");
                reply(response);
              },
              [reply](const drogon::orm::DrogonDbException&) {
                Json::Value body;
                body["error"] = "Database is unavailable";
                reply(JsonReply(body, drogon::k503ServiceUnavailable));
              });
        },
        {drogon::Get});

    // Every replica can resume overdue work after a restart
    std::weak_ptr<drogon::orm::DbClient> deadline_database = database;
    trantor::TimerId deadline_timer = trantor::InvalidTimerId;
    drogon::app().registerBeginningAdvice(
        [deadline_database, &deadline_timer]() {
          deadline_timer =
              drogon::app().getLoop()->runEvery(1.0, [deadline_database]() {
                // The global timer must not keep database threads alive at
                // shutdown
                if (auto client = deadline_database.lock()) {
                  client->execSqlAsync(
                      "SELECT vm_close_due(), vm_security_cleanup()",
                      [](const drogon::orm::Result&) {},
                      [](const drogon::orm::DrogonDbException&) {});
                }
              });
        });

    std::cout << "{\"service\":\"api\",\"event\":\"starting\",\"pool\":"
              << config.pool_size << "}\n";
    // Run app
    drogon::app()
        .setLogLevel(trantor::Logger::kWarn)
        .setThreadNum(2)
        .setClientMaxBodySize(4UL * 1024UL * 1024UL)
        .addListener("0.0.0.0", config.port)
        .run();

    // Stop background work before releasing connection threads
    drogon::app().getLoop()->invalidateTimer(deadline_timer);
    stop_live();
    database->closeAll();
  } catch (const std::invalid_argument& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  } catch (const std::exception&) {
    std::cerr << "API startup failed\n";
    return EXIT_FAILURE;
  }
}
