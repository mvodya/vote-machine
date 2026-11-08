// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#include "registration.hpp"

#include <memory>
#include <string>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {
// Decrypt credentials only after PostgreSQL has checked the caller's access
void RegistrationReply(const drogon::orm::Result& result, const Reply& reply,
                       const std::string& key) {
  if (result.empty()) {
    Unavailable(reply);
    return;
  }
  const auto text = result[0]["response"].as<std::string>();
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value body;
  if (!reader->parse(text.data(), text.data() + text.size(), &body, nullptr) ||
      !body["status"].isInt()) {
    Unavailable(reply);
    return;
  }
  const auto status = body["status"].asInt();
  if (status != 200 && status != 400 && status != 401 && status != 404 &&
      status != 409) {
    Unavailable(reply);
    return;
  }
  try {
    for (const auto* field : {"sessionCipher", "cipher"}) {
      if (!body[field].isString()) continue;
      const auto secret = DecryptSecret(body[field].asString(), key);
      const auto hash_field =
          std::string(field) == "cipher" ? "hash" : "sessionHash";
      if (HashSecret(secret) != body[hash_field].asString()) {
        Unavailable(reply);
        return;
      }
      body[std::string(field) == "cipher" ? "token" : "sessionToken"] = secret;
      body.removeMember(field);
      body.removeMember(hash_field);
    }
    body.removeMember("status");
    Send(reply, body, static_cast<drogon::HttpStatusCode>(status));
  } catch (const std::exception&) {
    Unavailable(reply);
  }
}

// Keep room authorization and each moderation action in one database call
void AdminRegistration(const drogon::orm::DbClientPtr& database,
                       const std::string& key,
                       const drogon::HttpRequestPtr& request,
                       const Reply& reply,
                       // Route fields follow their URL order
                       // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                       const std::string& room, const std::string& group,
                       const std::string& member, bool secret = false) {
  const auto session = Session(request);
  if (!IsRoomId(room) || !IsRoomId(group) || session.empty()) {
    Error(reply, drogon::k401Unauthorized, "Access required");
    return;
  }
  if (!member.empty() && !IsRoomId(member)) {
    Error(reply, drogon::k404NotFound, "Member not found");
    return;
  }
  Json::Value body(Json::objectValue);
  std::string action = secret ? "secret" : "list";
  if (request->method() == drogon::Get) {
    const auto after = request->getParameter("after");
    const auto filter = request->getParameter("filter");
    body["after"] = after.empty() ? "0" : after;
    body["filter"] = filter.empty() ? "registered" : filter;
  } else {
    const auto input = request->getJsonObject();
    if (!input || !input->isObject() || HasNull(*input) ||
        !(*input)["action"].isString()) {
      Error(reply, drogon::k400BadRequest, "Invalid action");
      return;
    }
    body = *input;
    action = body["action"].asString();
  }
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  database->execSqlAsync(
      "SELECT "
      "vm_registration_admin($1::uuid,decode($2,'hex'),$3::uuid,NULLIF($4,'')::"
      "uuid,$5,$6::jsonb)::text AS response",
      [reply, key](const drogon::orm::Result& result) {
        RegistrationReply(result, reply, key);
      },
      [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
      room, session, group, member, action, Json::writeString(writer, body));
}
}  // namespace

// Group entry uses its own cookie and never grants direct question access
void RegisterRegistrationHandlers(const drogon::orm::DbClientPtr& database,
                                  const std::string& encryption_key) {
  drogon::app().registerHandler(
      "/api/vote/{1}/registration",
      [database, encryption_key](const drogon::HttpRequestPtr& request,
                                 Reply&& reply, const std::string& group) {
        const auto session = Session(request);
        if (!IsRoomId(group) || session.empty()) {
          Error(reply, drogon::k401Unauthorized, "Access required");
          return;
        }
        Json::Value data(Json::objectValue);
        if (request->method() == drogon::Post) {
          const auto body = request->getJsonObject();
          if (!body || !body->isObject() || HasNull(*body) ||
              !(*body)["name"].isString()) {
            Error(reply, drogon::k400BadRequest, "Invalid name");
            return;
          }
          data["name"] = (*body)["name"];
          const auto personal_key = NewSecret();
          const auto child_session = NewSecret();
          data["hash"] = HashSecret(personal_key);
          data["cipher"] = EncryptSecret(personal_key, encryption_key);
          data["sessionHash"] = HashSecret(child_session);
          data["sessionCipher"] = EncryptSecret(child_session, encryption_key);
        }
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        database->execSqlAsync(
            "SELECT "
            "vm_registration_request($1::uuid,decode($2,'hex'),$3::jsonb)::"
            "text AS response",
            [reply, encryption_key](const drogon::orm::Result& result) {
              RegistrationReply(result, reply, encryption_key);
            },
            [reply](const drogon::orm::DrogonDbException&) {
              Unavailable(reply);
            },
            group, session, Json::writeString(writer, data));
      },
      {drogon::Get, drogon::Post});
  drogon::app().registerHandler(
      "/api/rooms/{1}/links/{2}/members",
      [database, encryption_key](
          const drogon::HttpRequestPtr& request, Reply&& reply,
          // Route fields follow their URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          const std::string& room, const std::string& group) {
        AdminRegistration(database, encryption_key, request, reply, room, group,
                          "");
      },
      {drogon::Get});
  drogon::app().registerHandler(
      "/api/rooms/{1}/links/{2}/members/{3}",
      [database, encryption_key](
          const drogon::HttpRequestPtr& request, Reply&& reply,
          // Route fields follow their URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          const std::string& room, const std::string& group,
          const std::string& member) {
        AdminRegistration(database, encryption_key, request, reply, room, group,
                          member);
      },
      {drogon::Patch});
  drogon::app().registerHandler(
      "/api/rooms/{1}/links/{2}/members/{3}/secret",
      [database, encryption_key](
          const drogon::HttpRequestPtr& request, Reply&& reply,
          // Route fields follow their URL order
          // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
          const std::string& room, const std::string& group,
          const std::string& member) {
        AdminRegistration(database, encryption_key, request, reply, room, group,
                          member, true);
      },
      {drogon::Get});
}
}  // namespace vote_machine
