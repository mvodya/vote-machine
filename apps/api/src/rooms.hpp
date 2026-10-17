#pragma once

#include <drogon/orm/DbClient.h>

#include <string>

namespace vote_machine {

// Add the room and admin access routes
void RegisterRoomHandlers(const drogon::orm::DbClientPtr& database,
                          const std::string& encryption_key);

}  // namespace vote_machine
