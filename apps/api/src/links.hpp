#pragma once

#include <drogon/orm/DbClient.h>

#include <string>

namespace vote_machine {

// Add admin link tools and participant access routes
void RegisterLinkHandlers(const drogon::orm::DbClientPtr& database,
                          const std::string& encryption_key);

}  // namespace vote_machine
