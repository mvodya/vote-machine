#include "access.hpp"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>

namespace vote_machine {
namespace {

// Check that link and session keys are different
TEST(AccessTest, SecretsAreIndependentAndUrlSafe) {
  const auto first = NewSecret();
  EXPECT_TRUE(IsSecret(first));
  EXPECT_NE(first, NewSecret());
  EXPECT_FALSE(IsSecret(first + "0"));
  EXPECT_FALSE(IsSecret(std::string(64, 'G')));
  EXPECT_FALSE(IsSecret(""));
}

// Check hashing against a known value
TEST(AccessTest, HashUsesSha256) {
  EXPECT_EQ(HashSecret("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  EXPECT_NE(HashSecret(NewSecret()), HashSecret(NewSecret()));
}

// Check round trips, changed data and wrong keys
TEST(AccessTest, StoredLinksUseAuthenticatedEncryption) {
  const auto secret = NewSecret();
  const auto key = NewSecret();
  const auto cipher = EncryptSecret(secret, key);
  EXPECT_EQ(cipher.size(), 184);
  EXPECT_EQ(DecryptSecret(cipher, key), secret);
  EXPECT_NE(cipher, EncryptSecret(secret, key));
  EXPECT_THROW(DecryptSecret(cipher, NewSecret()), std::runtime_error);
  auto changed = cipher;
  changed[30] = changed[30] == '0' ? '1' : '0';
  EXPECT_THROW(DecryptSecret(changed, key), std::runtime_error);
  EXPECT_THROW(EncryptSecret(secret, "bad"), std::invalid_argument);
  EXPECT_THROW(DecryptSecret("bad", key), std::invalid_argument);
}

// Reject IDs with extra text or wrong case
TEST(AccessTest, RoomIdsAreCanonical) {
  EXPECT_TRUE(IsRoomId("a96c3a49-0198-4545-8dce-44b70c86494d"));
  EXPECT_FALSE(IsRoomId("a96c3a49-0198-4545-8dce-44b70c86494d/other"));
  EXPECT_FALSE(IsRoomId("A96c3a49-0198-4545-8dce-44b70c86494d"));
  EXPECT_FALSE(IsRoomId("not-a-room"));
}

}  // namespace
}  // namespace vote_machine
