// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace vote_machine {

struct Config {
  // PostgreSQL connection address
  std::string database_url;
  // Port used by the HTTP server
  std::uint16_t port;
  // SQL connections per API replica, the listener adds one more
  std::size_t pool_size;
};

// Read and check the API settings
Config ParseConfig(std::string_view database_url, std::string_view port,
                   std::string_view pool_size = "");

}  // namespace vote_machine
