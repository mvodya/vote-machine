#include "voting.hpp"

#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
// Keep vote admission and writes in one database transaction
void RegisterVotingHandlers(const drogon::orm::DbClientPtr& database) {
  drogon::app().registerHandler(
      "/api/vote/{1}/questions",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& link) {
        const auto session = Session(request);
        if (!IsRoomId(link) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Participant access required");
          return;
        }
        Json::Value data(Json::objectValue);
        const auto after = request->getParameter("after");
        data["after"] = after.empty() ? "0" : after;
        for (const auto* name : {"selected", "skip"}) {
          const auto value = request->getParameter(name);
          if (!value.empty()) data[name] = value;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_participant_journey($1::uuid,decode($2,'hex'),$3::jsonb)::text "
            "AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            link, session, Json::writeString(writer, data));
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/vote/{1}/answers/{2}",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& link, const std::string& question) {
        const auto session = Session(request);
        if (!IsRoomId(link) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Participant access required");
          return;
        }
        if (!IsRoomId(question)) {
          Error(reply, drogon::k404NotFound, "Question not found");
          return;
        }
        Json::Value data(Json::objectValue);
        if (request->method() == drogon::Post) {
          const auto body = request->getJsonObject();
          if (!body || !body->isObject() || HasNull(*body)) {
            Error(reply, drogon::k400BadRequest, "Invalid answer");
            return;
          }
          data = *body;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            request->method() == drogon::Post
                ? "SELECT "
                  "vm_cast_personal($1::uuid,decode($2,'hex'),$3::uuid,$4::"
                  "jsonb)::text AS response"
                : "SELECT "
                  "vm_personal_answer($1::uuid,decode($2,'hex'),$3::uuid)::"
                  "text AS response WHERE $4::jsonb IS NOT NULL",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            link, session, question, Json::writeString(writer, data));
      },
      {drogon::Get, drogon::Post});
}
}  // namespace vote_machine
