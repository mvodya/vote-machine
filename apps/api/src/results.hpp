// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once
#include <drogon/orm/DbClient.h>

namespace vote_machine {

// Register filtered result reads for both roles
void RegisterResultHandlers(const drogon::orm::DbClientPtr& database);

}  // namespace vote_machine
