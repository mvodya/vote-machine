#include "config.hpp"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>

namespace vote_machine {
namespace {

TEST(ParseConfigTest, UsesDefaultPort) {
  const auto config = ParseConfig("postgresql://db/test", "");

  EXPECT_EQ(config.port, 8080);
  EXPECT_EQ(config.database_url, "postgresql://db/test");
}

TEST(ParseConfigTest, AcceptsValidPorts) {
  for (const std::string port : {"1", "65535", "3000"}) {
    SCOPED_TRACE(port);

    EXPECT_EQ(ParseConfig("postgresql://db/test", port).port, std::stoi(port));
  }
}

TEST(ParseConfigTest, RejectsInvalidPorts) {
  for (const std::string port :
       {"0", "65536", "-1", "80abc", " 80", "1.5", "999999999999999999999"}) {
    SCOPED_TRACE(port);

    EXPECT_THROW(ParseConfig("postgresql://db/test", port),
                 std::invalid_argument);
  }
}

TEST(ParseConfigTest, RequiresDatabaseUrl) {
  EXPECT_THROW(ParseConfig("", "8080"), std::invalid_argument);
}

}  // namespace
}  // namespace vote_machine
