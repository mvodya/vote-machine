#include <drogon/drogon.h>
#include <drogon/orm/DbClient.h>

#include <cstdlib>
#include <functional>
#include <iostream>
#include <string_view>

#include "config.hpp"

namespace {

using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

// Reading enviroment variable
std::string_view ReadEnv(const char* name) {
  const char* value = std::getenv(name);
  return value == nullptr ? "" : value;
}

// JSON response
drogon::HttpResponsePtr JsonReply(
    const Json::Value& body, drogon::HttpStatusCode status = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  response->addHeader("Cache-Control", "no-store");
  return response;
}

// Check DB status and send response
void CheckDatabase(const drogon::orm::DbClientPtr& database, const Reply& reply,
                   bool hello) {
  database->execSqlAsync(
      "SELECT $1::text AS message",
      [reply, hello](const drogon::orm::Result& result) {
        Json::Value body;
        if (hello) {
          body["message"] = result[0]["message"].as<std::string>();
          body["database"] = "connected";
        } else {
          body["status"] = "ready";
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

int main() {
  try {
    // Read config
    const auto config =
        vote_machine::ParseConfig(ReadEnv("DATABASE_URL"), ReadEnv("API_PORT"));
    // Connect database
    auto database = drogon::orm::DbClient::newPgClient(config.database_url, 2);
    database->setTimeout(3.0);

    // Register handlers
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

    // Run app
    drogon::app()
        .setLogLevel(trantor::Logger::kWarn)
        .setThreadNum(2)
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
