#include "config.hpp"

#include <charconv>
#include <stdexcept>
#include <system_error>

namespace vote_machine {

// Read and check the API settings
Config ParseConfig(std::string_view database_url, std::string_view port,
                   std::string_view pool_size) {
  // A database address is required
  if (database_url.empty()) {
    throw std::invalid_argument("DATABASE_URL is required");
  }
  // Use the default port when none is set
  if (port.empty()) {
    port = "8080";
  }
  unsigned int parsed_port = 0;
  // Read the whole value without changing it
  const auto [end, error] =
      std::from_chars(port.data(), port.data() + port.size(), parsed_port);
  // Reject text, zero and ports outside the allowed range
  if (error != std::errc{} || end != port.data() + port.size() ||
      parsed_port == 0 || parsed_port > 65535) {
    throw std::invalid_argument("API_PORT must be between 1 and 65535");
  }
  // Bound each replica so scaling does not create an unlimited SQL pool
  if (pool_size.empty()) pool_size = "2";
  unsigned int parsed_pool = 0;
  const auto [pool_end, pool_error] = std::from_chars(
      pool_size.data(), pool_size.data() + pool_size.size(), parsed_pool);
  if (pool_error != std::errc{} ||
      pool_end != pool_size.data() + pool_size.size() || parsed_pool < 1 ||
      parsed_pool > 32) {
    throw std::invalid_argument("DB_POOL_SIZE must be between 1 and 32");
  }
  return {std::string(database_url), static_cast<std::uint16_t>(parsed_port),
          parsed_pool};
}

}  // namespace vote_machine
