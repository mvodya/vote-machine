#include "questions.hpp"

#include <memory>
#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {

// PostgreSQL text cannot store a null character
bool HasNull(const Json::Value& value) {
  if (value.isString()) return value.asString().find('\0') != std::string::npos;
  if (value.isObject()) {
    for (const auto& name : value.getMemberNames())
      if (name.find('\0') != std::string::npos || HasNull(value[name]))
        return true;
  } else if (value.isArray()) {
    for (const auto& item : value)
      if (HasNull(item)) return true;
  }
  return false;
}

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
  }
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      "SELECT vm_question_request($1::uuid,decode($2,'hex'),"
      "NULLIF($3,'')::uuid,$4,$5::jsonb)::text AS response",
      [reply](const drogon::orm::Result& result) {
        Json::Value body;
        Json::CharReaderBuilder reader;
        const auto text = result[0]["response"].as<std::string>();
        const std::unique_ptr<Json::CharReader> parser(reader.newCharReader());
        const bool parsed = parser->parse(
            text.data(), text.data() + text.size(), &body, nullptr);
        // Database errors must not expose query text or keys
        if (!parsed || !body.isObject() || !body["status"].isInt()) {
          Unavailable(reply);
          return;
        }
        const auto status = body["status"].asInt();
        if (status != 200 && status != 201 && status != 400 && status != 401 &&
            status != 404 && status != 409) {
          Unavailable(reply);
          return;
        }
        body.removeMember("status");
        Send(reply, body, static_cast<drogon::HttpStatusCode>(status));
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
