// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once
#include <drogon/orm/DbClient.h>

#include <string>
namespace vote_machine {

// Add media access and private worker routes
void RegisterAssetHandlers(const drogon::orm::DbClientPtr& database,
                           const std::string& worker_key);

}  // namespace vote_machine
