#include "voting.hpp"

#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
// Keep vote admission and writes in one database transaction
void RegisterVotingHandlers(const drogon::orm::DbClientPtr& database) {
  drogon::app().registerHandler(
      "/api/vote/{1}/presence",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& link) {
        const auto session = Session(request);
        if (!IsRoomId(link) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        const auto body = request->getJsonObject();
        if (!body || !body->isObject()) {
          Error(reply, drogon::k400BadRequest, "Invalid view");
          return;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_question_presence($1::uuid,decode($2,'hex'),$3::jsonb)::text "
            "AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            link, session, Json::writeString(writer, *body));
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/vote/{1}/runs",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& link) {
        const auto session = Session(request);
        const auto body = request->getJsonObject();
        if (!IsRoomId(link) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        if (!body || !body->isObject() || !(*body)["requestId"].isString() ||
            !IsRoomId((*body)["requestId"].asString())) {
          Error(reply, drogon::k400BadRequest, "Invalid run");
          return;
        }
        database->execSqlAsync(
            "SELECT vm_begin_run($1::uuid,decode($2,'hex'),$3::uuid)::text AS "
            "response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            link, session, (*body)["requestId"].asString());
      },
      {drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/reuse-policy",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 const std::string& room) {
        const auto session = Session(request);
        if (!IsRoomId(room) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        Json::Value data(Json::objectValue);
        if (request->method() != drogon::Get) {
          const auto body = request->getJsonObject();
          if (!body || !body->isObject() || HasNull(*body)) {
            Error(reply, drogon::k400BadRequest, "Invalid policy");
            return;
          }
          data = *body;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT vm_reuse_policy($1::uuid,decode($2,'hex'),$3::jsonb)::text "
            "AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, Json::writeString(writer, data));
      },
      {drogon::Get, drogon::Patch});
  drogon::app().registerHandler(
      "/api/rooms/{1}/questions/{2}/manual",
      [database](const drogon::HttpRequestPtr& request, Reply&& reply,
                 // Route fields follow the URL order
                 // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                 const std::string& room, const std::string& question) {
        const auto session = Session(request);
        if (!IsRoomId(room) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        if (!IsRoomId(question)) {
          Error(reply, drogon::k404NotFound, "Question not found");
          return;
        }
        Json::Value data(Json::objectValue);
        if (request->method() == drogon::Get) {
          data["linkId"] = request->getParameter("linkId");
        } else {
          const auto body = request->getJsonObject();
          if (!body || !body->isObject() || HasNull(*body)) {
            Error(reply, drogon::k400BadRequest, "Invalid ballot");
            return;
          }
          data = *body;
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            request->method() == drogon::Get
                ? "SELECT "
                  "vm_manual_context($1::uuid,decode($2,'hex'),$3::uuid,NULLIF("
                  "$4::jsonb->>'linkId','')::uuid)::text AS response"
                : "SELECT "
                  "vm_cast_ballot($1::uuid,NULL,decode($2,'hex'),true,$3::uuid,"
                  "$4::jsonb)::text AS response",
            [reply](const drogon::orm::Result& result) {
              DatabaseReply(result, reply);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            room, session, question, Json::writeString(writer, data));
      },
      {drogon::Get, drogon::Post});
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
        for (const auto* name : {"selected", "skip", "run"}) {
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
        const auto run = request->getParameter("run");
        if (!run.empty()) {
          if (!IsRoomId(run)) {
            Error(reply, drogon::k400BadRequest, "Invalid run");
            return;
          }
          data["runId"] = run;
        }
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
                ? "SELECT CASE WHEN $4::jsonb ? 'runId' THEN "
                  "vm_cast_ballot(NULL,$1::uuid,decode($2,'hex'),false,$3::"
                  "uuid,$4::jsonb) ELSE "
                  "vm_cast_personal($1::uuid,decode($2,'hex'),$3::uuid,$4::"
                  "jsonb) END::text AS response"
                : "SELECT "
                  "vm_current_answer($1::uuid,decode($2,'hex'),$3::uuid,($4::"
                  "jsonb->>'runId')::uuid)::"
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
