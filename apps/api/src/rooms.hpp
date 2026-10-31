// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once

#include <drogon/orm/DbClient.h>

#include <string>

namespace vote_machine {

// Add the room and admin access routes
void RegisterRoomHandlers(const drogon::orm::DbClientPtr& database,
                          const std::string& encryption_key);

}  // namespace vote_machine
