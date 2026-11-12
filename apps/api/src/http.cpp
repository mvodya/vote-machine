// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#include "http.hpp"

#include <memory>

#include "access.hpp"

namespace vote_machine {

// Send private JSON without caching
void Send(const Reply& reply, const Json::Value& body,
          drogon::HttpStatusCode status) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  response->addHeader("Cache-Control", "no-store");
  response->addHeader("Referrer-Policy", "no-referrer");
  reply(response);
}

// Send a short error without private details
void Error(const Reply& reply, drogon::HttpStatusCode status,
           const std::string& message) {
  Json::Value body;
  body["error"] = message;
  Send(reply, body, status);
}

// Read and hash the session key from the request
std::string Session(const drogon::HttpRequestPtr& request) {
  const auto& authorization = request->getHeader("Authorization");
  constexpr std::string_view kPrefix = "Bearer ";
  // Cookies are handled by the web server, not here
  if (!authorization.starts_with(kPrefix)) return "";
  const auto token = authorization.substr(kPrefix.size());
  return IsSecret(token) ? HashSecret(token) : "";
}

// Hide database and crypto errors from the client
void Unavailable(const Reply& reply) {
  Error(reply, drogon::k503ServiceUnavailable, "Service is unavailable");
}

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

// Send only known database status codes and hide bad replies
void DatabaseReply(const drogon::orm::Result& result, const Reply& reply) {
  if (result.empty()) {
    Unavailable(reply);
    return;
  }

  Json::Value body;
  Json::CharReaderBuilder reader;
  const auto text = result[0]["response"].as<std::string>();
  const std::unique_ptr<Json::CharReader> parser(reader.newCharReader());
  if (!parser->parse(text.data(), text.data() + text.size(), &body, nullptr) ||
      !body.isObject() || !body["status"].isInt()) {
    Unavailable(reply);
    return;
  }

  const auto status = body["status"].asInt();
  if (status != 200 && status != 201 && status != 400 && status != 401 &&
      status != 403 && status != 404 && status != 409 && status != 413 &&
      status != 415 && status != 429) {
    Unavailable(reply);
    return;
  }

  body.removeMember("status");
  Send(reply, body, static_cast<drogon::HttpStatusCode>(status));
}

}  // namespace vote_machine
