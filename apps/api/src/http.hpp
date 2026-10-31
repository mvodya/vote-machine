// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once

#include <drogon/drogon.h>
#include <drogon/orm/Exception.h>
#include <drogon/orm/Result.h>

#include <functional>
#include <string>

namespace vote_machine {

using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

// Send private JSON without caching
void Send(const Reply& reply, const Json::Value& body,
          drogon::HttpStatusCode status = drogon::k200OK);

// Send a short error without private details
void Error(const Reply& reply, drogon::HttpStatusCode status,
           const std::string& message);

// Read and hash the session key from the request
std::string Session(const drogon::HttpRequestPtr& request);

// Hide service errors from the client
void Unavailable(const Reply& reply);

// Reject null characters before passing JSON to PostgreSQL
bool HasNull(const Json::Value& value);

// Read a short response from a database entry point
void DatabaseReply(const drogon::orm::Result& result, const Reply& reply);

}  // namespace vote_machine
