// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#include "access.hpp"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <array>
#include <memory>
#include <stdexcept>

namespace vote_machine {
namespace {

// Turn bytes into hex text
std::string Hex(const unsigned char* bytes, std::size_t length) {
  constexpr char kDigits[] = "0123456789abcdef";
  std::string result;
  // Each byte needs two hex digits
  result.reserve(length * 2);
  for (std::size_t i = 0; i < length; ++i) {
    // Write the high and low half of the byte
    result += kDigits[bytes[i] >> 4];
    result += kDigits[bytes[i] & 15];
  }
  return result;
}

// Check one lowercase hex digit
bool IsHex(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

}  // namespace

// Make a new random link or session key
std::string NewSecret() {
  std::array<unsigned char, 32> bytes{};
  // Stop if random bytes are not available
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
    throw std::runtime_error("Secret generation failed");
  }
  return Hex(bytes.data(), bytes.size());
}

// Hash a secret before checking or storing it
std::string HashSecret(std::string_view secret) {
  std::array<unsigned char, EVP_MAX_MD_SIZE> hash{};
  unsigned int length = 0;
  // Stop if hashing fails
  if (EVP_Digest(secret.data(), secret.size(), hash.data(), &length,
                 EVP_sha256(), nullptr) != 1) {
    throw std::runtime_error("Secret hashing failed");
  }
  return Hex(hash.data(), length);
}

// Check the length and allowed characters of a secret
bool IsSecret(std::string_view secret) {
  // A secret must have 64 hex digits
  if (secret.size() != 64) return false;
  for (char value : secret) {
    if (!IsHex(value)) return false;
  }
  return true;
}

// Encrypt the link and add a check tag
std::string EncryptSecret(std::string_view secret, std::string_view key) {
  // Check both keys before using them
  if (!IsSecret(secret) || !IsSecret(key))
    throw std::invalid_argument("Invalid secret settings");
  std::array<unsigned char, 32> key_bytes{};
  // Read the hex key as bytes
  for (std::size_t i = 0; i < key_bytes.size(); ++i) {
    key_bytes[i] = static_cast<unsigned char>(
        std::stoul(std::string(key.substr(i * 2, 2)), nullptr, 16));
  }
  // Save 12 random bytes, 64 data bytes and a 16-byte check tag
  std::array<unsigned char, 92> bytes{};
  // Use new random bytes each time
  if (RAND_bytes(bytes.data(), 12) != 1)
    throw std::runtime_error("Secret encryption failed");
  // Free the crypto context when this call ends
  const std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  int length = 0;
  int tail = 0;
  // Encrypt the secret and save the check tag
  if (!ctx ||
      EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr,
                         key_bytes.data(), bytes.data()) != 1 ||
      EVP_EncryptUpdate(ctx.get(), bytes.data() + 12, &length,
                        reinterpret_cast<const unsigned char*>(secret.data()),
                        64) != 1 ||
      EVP_EncryptFinal_ex(ctx.get(), bytes.data() + 12 + length, &tail) != 1 ||
      EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, 16,
                          bytes.data() + 76) != 1) {
    throw std::runtime_error("Secret encryption failed");
  }
  return Hex(bytes.data(), bytes.size());
}

// Read a stored link and check that it was not changed
std::string DecryptSecret(std::string_view cipher, std::string_view key) {
  // Check the saved data length and the key
  if (cipher.size() != 184 || !IsSecret(key))
    throw std::invalid_argument("Invalid secret settings");
  // Save 12 random bytes, 64 data bytes and a 16-byte check tag
  std::array<unsigned char, 92> bytes{};
  std::array<unsigned char, 32> key_bytes{};
  // Reject text that is not hex
  for (char value : cipher)
    if (!IsHex(value)) throw std::invalid_argument("Invalid encrypted secret");
  // Read the saved hex data as bytes
  for (std::size_t i = 0; i < bytes.size(); ++i)
    bytes[i] = static_cast<unsigned char>(
        std::stoul(std::string(cipher.substr(i * 2, 2)), nullptr, 16));
  // Read the hex key as bytes
  for (std::size_t i = 0; i < key_bytes.size(); ++i)
    key_bytes[i] = static_cast<unsigned char>(
        std::stoul(std::string(key.substr(i * 2, 2)), nullptr, 16));
  // Free the crypto context when this call ends
  const std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(
      EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  std::array<unsigned char, 80> plain{};
  int length = 0;
  int tail = 0;
  // Check the tag before using the saved secret
  if (!ctx ||
      EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr,
                         key_bytes.data(), bytes.data()) != 1 ||
      EVP_DecryptUpdate(ctx.get(), plain.data(), &length, bytes.data() + 12,
                        64) != 1 ||
      EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, 16,
                          bytes.data() + 76) != 1 ||
      EVP_DecryptFinal_ex(ctx.get(), plain.data() + length, &tail) != 1)
    throw std::runtime_error("Secret decryption failed");
  std::string secret(reinterpret_cast<const char*>(plain.data()), 64);
  // Only return a valid link key
  if (!IsSecret(secret)) throw std::runtime_error("Secret decryption failed");
  return secret;
}

// Check the room ID before using it in SQL
bool IsRoomId(std::string_view id) {
  // A room ID has a fixed length
  if (id.size() != 36) return false;
  for (std::size_t i = 0; i < id.size(); ++i) {
    // Check dashes at their fixed positions
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!IsHex(id[i])) {
      return false;
    }
  }
  return true;
}

}  // namespace vote_machine
