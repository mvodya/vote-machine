#pragma once

#include <string>
#include <string_view>

namespace vote_machine {

// Use separate random secrets for links and sessions
std::string NewSecret();
// Make a hash for storage and access checks
std::string HashSecret(std::string_view secret);
// Encrypt a link for later use
std::string EncryptSecret(std::string_view secret, std::string_view key);
// Read and check an encrypted link
std::string DecryptSecret(std::string_view cipher, std::string_view key);
// Check the secret length and characters
bool IsSecret(std::string_view secret);
// Check the room ID format
bool IsRoomId(std::string_view id);

}  // namespace vote_machine
