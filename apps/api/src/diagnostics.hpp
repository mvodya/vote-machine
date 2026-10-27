#pragma once

#include <drogon/drogon.h>

#include <chrono>
#include <cstdlib>
#include <string>

#include "access.hpp"

#ifndef VOTE_MACHINE_COMMIT
#define VOTE_MACHINE_COMMIT "dev"
#endif

namespace vote_machine {
// Share safe clock and process labels without keys or network addresses
inline Json::Value ConnectionInfo() {
  Json::Value data;
  const auto* host = std::getenv("HOSTNAME");
  data["apiId"] = HashSecret(host == nullptr ? "local" : host).substr(0, 12);
  data["commit"] = VOTE_MACHINE_COMMIT;
  data["serverTime"] = static_cast<Json::Int64>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
  return data;
}
}  // namespace vote_machine
