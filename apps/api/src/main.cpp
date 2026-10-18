#include <drogon/drogon.h>
#include <drogon/orm/DbClient.h>

#include <cstdlib>
#include <functional>
#include <iostream>
#include <string_view>

#include "assets.hpp"
#include "config.hpp"
#include "links.hpp"
#include "questions.hpp"
#include "rooms.hpp"

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
              "jsonb)') IS NOT NULL AS schema_ready",
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
    const auto config =
        vote_machine::ParseConfig(ReadEnv("DATABASE_URL"), ReadEnv("API_PORT"));
    // Connect database
    auto database = drogon::orm::DbClient::newPgClient(config.database_url, 2);
    database->setTimeout(3.0);

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
        [database](const drogon::HttpRequestPtr&, Reply&& reply) {
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
    vote_machine::RegisterAssetHandlers(
        database, std::string(ReadEnv("MEDIA_WORKER_KEY")));

    // Run app
    drogon::app()
        .setLogLevel(trantor::Logger::kWarn)
        .setThreadNum(2)
        .setClientMaxBodySize(4UL * 1024UL * 1024UL)
        .addListener("0.0.0.0", config.port)
        .run();

    // Disconnect database
    database->closeAll();
  } catch (const std::invalid_argument& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  } catch (const std::exception&) {
    std::cerr << "API startup failed\n";
    return EXIT_FAILURE;
  }
}
