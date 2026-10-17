#include "config.hpp"

#include <charconv>
#include <stdexcept>
#include <system_error>

namespace vote_machine {

// Read and check the API settings
Config ParseConfig(std::string_view database_url, std::string_view port) {
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
  return {std::string(database_url), static_cast<std::uint16_t>(parsed_port)};
}

}  // namespace vote_machine
