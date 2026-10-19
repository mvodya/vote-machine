#pragma once
#include <drogon/orm/DbClient.h>

#include <string>
namespace vote_machine {
// Accept network context only from our private web ingress
void RegisterSecurityHandlers(const drogon::orm::DbClientPtr& database,
                              const std::string& gateway_key);
}  // namespace vote_machine
