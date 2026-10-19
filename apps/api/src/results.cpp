#include "results.hpp"

#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {
// Let PostgreSQL apply the same publication rules to each view
void ReadResults(const drogon::orm::DbClientPtr& database,
                 const drogon::HttpRequestPtr& request, const Reply& reply,
                 const std::string& identity, bool admin) {
  const auto session = Session(request);
  if (!IsRoomId(identity) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Access required");
    return;
  }
  const auto question = request->getParameter("question");
  if (!question.empty() && !IsRoomId(question)) {
    Error(reply, drogon::k400BadRequest, "Invalid question");
    return;
  }
  Json::Value data(Json::objectValue);
  for (const auto* key : {"after", "peopleAfter", "run", "view"}) {
    const auto value = request->getParameter(key);
    if (!value.empty()) data[key] = value;
  }
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      "SELECT "
      "vm_results($1::uuid,decode($2,'hex'),$3::boolean,NULLIF($4,'')::uuid,$5:"
      ":jsonb)::text AS response",
      [reply](const drogon::orm::Result& result) {
        DatabaseReply(result, reply);
      },
      [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
      identity, session, admin, question, Json::writeString(writer, data));
}
}  // namespace
// Check access and share only presentation data
void Experience(const drogon::orm::DbClientPtr& database,
                const drogon::HttpRequestPtr& request, const Reply& reply,
                const std::string& identity, bool admin) {
  const auto session = Session(request);
  if (!IsRoomId(identity) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Access required");
    return;
  }
  Json::Value data(Json::objectValue);
  if (request->method() == drogon::Patch) {
    const auto body = request->getJsonObject();
    if (!body || !body->isObject() || !(*body)["accent"].isString()) {
      Error(reply, drogon::k400BadRequest, "Invalid accent");
      return;
    }
    data["accent"] = (*body)["accent"];
  }
  const auto after = request->getParameter("after");
  if (!after.empty()) data["after"] = after;
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      "SELECT "
      "vm_room_experience($1::uuid,decode($2,'hex'),$3::boolean,$4::jsonb)::"
      "text AS response",
      [reply](const drogon::orm::Result& result) {
        DatabaseReply(result, reply);
      },
      [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
      identity, session, admin, Json::writeString(writer, data));
}
// Keep role selection in the route rather than a client field
void RegisterResultHandlers(const drogon::orm::DbClientPtr& database) {
  drogon::app().registerHandler(
      "/api/rooms/{1}/experience",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        Experience(database, request, reply, id, true);
      },
      {drogon::Get, drogon::Patch});
  drogon::app().registerHandler(
      "/api/vote/{1}/experience",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& id) {
        Experience(database, request, reply, id, false);
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/rooms/{1}/presence",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        const auto session = Session(request);
        if (!IsRoomId(room) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        const auto body = request->getJsonObject();
        if (!body || !body->isObject() || !(*body)["ids"].isArray() ||
            (*body)["ids"].size() > 50) {
          Error(reply, drogon::k400BadRequest, "Invalid links");
          return;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_admin_presence($1::uuid,decode($2,'hex'),$3::jsonb)::text AS "
            "response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, Json::writeString(writer, (*body)["ids"]));
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/results",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        ReadResults(database, request, reply, room, true);
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/vote/{1}/results",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& link) {
        ReadResults(database, request, reply, link, false);
      },
      {drogon::Get});
}
}  // namespace vote_machine
