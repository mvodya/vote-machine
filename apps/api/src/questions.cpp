#include "questions.hpp"

#include <string>

#include "access.hpp"
#include "http.hpp"
#include "markdown.hpp"

namespace vote_machine {
namespace {

// Keep room access and data changes in one database call
void RequestQuestion(const drogon::orm::DbClientPtr& database,
                     const drogon::HttpRequestPtr& request, const Reply& reply,
                     // Fields follow the database call order
                     // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                     const std::string& room, const std::string& id,
                     const std::string& action) {
  const auto session = Session(request);
  // A participant session cannot select an admin room
  if (!IsRoomId(room) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Admin access required");
    return;
  }
  if (!id.empty() && !IsRoomId(id)) {
    Error(reply, drogon::k404NotFound, "Question not found");
    return;
  }
  Json::Value data(Json::objectValue);
  if (request->method() == drogon::Get) {
    const auto after = request->getParameter("after");
    data["after"] = after.empty() ? "0" : after;
  } else {
    const auto body = request->getJsonObject();
    // Reject broken JSON before passing it to PostgreSQL
    if (!body || !body->isObject() || HasNull(*body)) {
      Error(reply, drogon::k400BadRequest, "Invalid question");
      return;
    }
    data = *body;
    // Use parsed media nodes instead of client-supplied references
    if ((action == "create" || action == "save") &&
        !MarkdownReferences(data, data["assetRefs"])) {
      Error(reply, drogon::k400BadRequest, "Invalid Markdown or media source");
      return;
    }
  }
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      action == "reset" ? "SELECT "
                          "vm_reset_question($1::uuid,decode($2,'hex'),$3::"
                          "uuid,$5::jsonb)::text AS response WHERE $4 = 'reset'"
      : action == "lifecycle"
          ? "SELECT "
            "vm_question_lifecycle($1::uuid,decode($2,'hex'),$3::uuid,$5::"
            "jsonb)::text AS response WHERE $4 = 'lifecycle'"
          : "SELECT "
            "vm_question_request($1::uuid,decode($2,'hex'),NULLIF($3,'')::uuid,"
            "$4,$5::jsonb)::text AS response",
      [reply](const drogon::orm::Result& result) {
        DatabaseReply(result, reply);
      },
      [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
      room, session, id, action, Json::writeString(writer, data));
}

}  // namespace

// Map HTTP methods to the database question actions
void RegisterQuestionHandlers(const drogon::orm::DbClientPtr& database) {
  drogon::app().registerHandler(
      "/api/rooms/{1}/question-policy",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        RequestQuestion(
            database, request, reply, room, "",
            request->method() == drogon::Get ? "policy" : "setPolicy");
      },
      {drogon::Get, drogon::Patch});
  drogon::app().registerHandler(
      "/api/rooms/{1}/questions",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        RequestQuestion(database, request, reply, room, "",
                        request->method() == drogon::Get ? "list" : "create");
      },
      {drogon::Get, drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/questions/{2}/reset",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& room, const std::string& id) {
        RequestQuestion(database, request, reply, room, id, "reset");
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/questions/{2}/lifecycle",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& room, const std::string& id) {
        RequestQuestion(database, request, reply, room, id, "lifecycle");
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/questions/{2}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& room, const std::string& id) {
        const auto action = request->method() == drogon::Get     ? "get"
                            : request->method() == drogon::Patch ? "save"
                                                                 : "delete";
        RequestQuestion(database, request, reply, room, id, action);
      },
      {drogon::Get, drogon::Patch, drogon::Delete});
}

}  // namespace vote_machine
