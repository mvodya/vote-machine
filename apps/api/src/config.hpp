#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace vote_machine {

struct Config {
  // PostgreSQL connection address
  std::string database_url;
  // Port used by the HTTP server
  std::uint16_t port;
};

// Read and check the API settings
Config ParseConfig(std::string_view database_url, std::string_view port);

}  // namespace vote_machine
