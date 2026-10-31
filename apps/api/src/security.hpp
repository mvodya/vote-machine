// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once
#include <drogon/orm/DbClient.h>

#include <string>

namespace vote_machine {

// Accept network context only from our private web ingress
void RegisterSecurityHandlers(const drogon::orm::DbClientPtr& database,
                              const std::string& gateway_key);

}  // namespace vote_machine
