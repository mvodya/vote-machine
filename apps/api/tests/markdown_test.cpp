#include "markdown.hpp"

#include <gtest/gtest.h>

namespace vote_machine {
namespace {

const std::string kId = "a96c3a49-0198-4545-8dce-44b70c86494d";
// Match the full source fields used by question saves
Json::Value Document(const std::string& source) {
  Json::Value value;
  value["content"] = source;
  value["choices"] = Json::Value(Json::arrayValue);
  return value;
}

TEST(MarkdownTest, ReferencesUseParsedImagesInsteadOfExamplesOrHtml) {
  auto value = Document("![Photo](asset:" + kId +
                        ")\n\n```md\n![Example](https://"
                        "evil.test)\n```\n\n<img src='https://evil.test'>");
  Json::Value refs;
  ASSERT_TRUE(MarkdownReferences(value, refs));
  ASSERT_EQ(refs.size(), 1U);
  EXPECT_EQ(refs[0]["position"].asInt(), -1);
  EXPECT_EQ(refs[0]["assetId"].asString(), kId);
  value["content"] = "![Ref][media]\n\n[media]: asset:" + kId;
  ASSERT_TRUE(MarkdownReferences(value, refs));
  EXPECT_EQ(refs.size(), 1U);
}

TEST(MarkdownTest, BadMediaAndUnsafeLinksCannotBeSaved) {
  for (const auto* source :
       {"![Remote](https://evil.test/x.png)", "![Bad](javascript:alert(1))",
        "[Bad](javascript:alert(1))", "[Bad](java&#x73;cript:alert(1))",
        "[Bad](data:text/html,x)", "[Bad](//evil.test)"}) {
    Json::Value refs;
    EXPECT_FALSE(MarkdownReferences(Document(source), refs));
  }
}

TEST(MarkdownTest, ReferencesKeepTheirOptionPositionAndIgnoreClientMetadata) {
  auto value = Document("Text");
  Json::Value choice;
  choice["content"] = "![A](asset:" + kId + ") ![B](asset:" + kId + ")";
  value["choices"].append(choice);
  value["assetRefs"] = "not trusted";
  Json::Value refs;
  ASSERT_TRUE(MarkdownReferences(value, refs));
  ASSERT_EQ(refs.size(), 1U);
  EXPECT_EQ(refs[0]["position"].asInt(), 0);
}

TEST(MarkdownTest, OnlySafeLinkKindsAreAccepted) {
  EXPECT_TRUE(SafeMarkdownLink("https://example.com"));
  EXPECT_TRUE(SafeMarkdownLink("/rooms/test"));
  EXPECT_TRUE(SafeMarkdownLink("#part"));
  EXPECT_FALSE(SafeMarkdownLink("/\\evil.test"));
  EXPECT_FALSE(SafeMarkdownLink("https://example.com\n"));
}

}  // namespace
}  // namespace vote_machine
