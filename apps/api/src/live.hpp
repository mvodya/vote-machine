// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once
#include <drogon/orm/DbClient.h>

#include <functional>
#include <string>

namespace vote_machine {

// Return shutdown work so listeners stop before database threads
std::function<void()> RegisterLiveHandlers(
    const drogon::orm::DbClientPtr& database, const std::string& connection);

}  // namespace vote_machine
