#include "config.hpp"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>

namespace vote_machine {
namespace {

// Use the default port when it is not set
TEST(ParseConfigTest, UsesDefaultPort) {
  const auto config = ParseConfig("postgresql://db/test", "");

  EXPECT_EQ(config.port, 8080);
  EXPECT_EQ(config.database_url, "postgresql://db/test");
}

// Check the allowed port range
TEST(ParseConfigTest, AcceptsValidPorts) {
  for (const std::string port : {"1", "65535", "3000"}) {
    SCOPED_TRACE(port);

    EXPECT_EQ(ParseConfig("postgresql://db/test", port).port, std::stoi(port));
  }
}

// Reject values that are not whole valid ports
TEST(ParseConfigTest, RejectsInvalidPorts) {
  for (const std::string port :
       {"0", "65536", "-1", "80abc", " 80", "1.5", "999999999999999999999"}) {
    SCOPED_TRACE(port);

    EXPECT_THROW(ParseConfig("postgresql://db/test", port),
                 std::invalid_argument);
  }
}

// Fail before startup when the database address is missing
TEST(ParseConfigTest, RequiresDatabaseUrl) {
  EXPECT_THROW(ParseConfig("", "8080"), std::invalid_argument);
}

// Reject oversized pools before a replica opens connections
TEST(ParseConfigTest, BoundsPoolSize) {
  EXPECT_EQ(ParseConfig("postgresql://db/test", "").pool_size, 2);
  EXPECT_EQ(ParseConfig("postgresql://db/test", "", "32").pool_size, 32);
  for (const std::string pool : {"0", "33", "-1", "2bad", " 2"}) {
    EXPECT_THROW(ParseConfig("postgresql://db/test", "", pool),
                 std::invalid_argument);
  }
}

}  // namespace
}  // namespace vote_machine
