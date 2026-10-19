#pragma once
#include <drogon/orm/DbClient.h>

#include <functional>
#include <string>
namespace vote_machine {
// Return shutdown work so listeners stop before database threads
std::function<void()> RegisterLiveHandlers(
    const drogon::orm::DbClientPtr& database, const std::string& connection);
}  // namespace vote_machine
