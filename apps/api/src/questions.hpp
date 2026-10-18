#pragma once

#include <drogon/orm/DbClient.h>

namespace vote_machine {

// Add the admin question routes
void RegisterQuestionHandlers(const drogon::orm::DbClientPtr& database);

}  // namespace vote_machine
