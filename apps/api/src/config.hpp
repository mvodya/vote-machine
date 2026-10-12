#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace vote_machine {

struct Config {
  std::string database_url;
  std::uint16_t port;
};

// Prepare config
Config ParseConfig(std::string_view database_url, std::string_view port);

}  // namespace vote_machine
