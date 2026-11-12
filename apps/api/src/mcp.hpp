// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once

#include <drogon/orm/DbClient.h>

#include <string>

namespace vote_machine {

// Register the private bridge used by the MCP and agent HTTP endpoints
void RegisterMcpHandlers(const drogon::orm::DbClientPtr& database,
                         const std::string& gateway_key,
                         const std::string& encryption_key);

}  // namespace vote_machine
