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
  for (const auto* key : {"after", "peopleAfter", "run"}) {
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
// Keep role selection in the route rather than a client field
void RegisterResultHandlers(const drogon::orm::DbClientPtr& database) {
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
