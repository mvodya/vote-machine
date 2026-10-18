#pragma once
#include <drogon/orm/DbClient.h>

namespace vote_machine {
// Add personal answer routes with separate participant access
void RegisterVotingHandlers(const drogon::orm::DbClientPtr& database);
}  // namespace vote_machine
