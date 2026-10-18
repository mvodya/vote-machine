#include "markdown.hpp"

#include <cmark-gfm.h>

#include <algorithm>
#include <cctype>
#include <memory>
#include <set>
#include <string>
#include <utility>

#include "access.hpp"

namespace vote_machine {
namespace {
// Parse image nodes with the same CommonMark rules as the editor
bool ReadSource(const std::string& source, int position,
                std::set<std::pair<int, std::string>>& found) {
  const std::unique_ptr<cmark_node, decltype(&cmark_node_free)> root(
      cmark_parse_document(source.data(), source.size(), CMARK_OPT_DEFAULT),
      cmark_node_free);
  if (!root) return false;
  const std::unique_ptr<cmark_iter, decltype(&cmark_iter_free)> iterator(
      cmark_iter_new(root.get()), cmark_iter_free);
  cmark_event_type event;
  while ((event = cmark_iter_next(iterator.get())) != CMARK_EVENT_DONE) {
    if (event != CMARK_EVENT_ENTER) continue;
    auto* node = cmark_iter_get_node(iterator.get());
    const auto type = cmark_node_get_type(node);
    if (type != CMARK_NODE_IMAGE && type != CMARK_NODE_LINK) continue;
    const char* raw = cmark_node_get_url(node);
    const std::string url = raw == nullptr ? "" : raw;
    if (type == CMARK_NODE_IMAGE) {
      // Only generated asset IDs may act as media sources
      if (!url.starts_with("asset:") || !IsRoomId(url.substr(6))) return false;
      found.emplace(position, url.substr(6));
    } else if (!SafeMarkdownLink(url)) {
      return false;
    }
  }
  return true;
}
}  // namespace

// Do not accept hidden control bytes or protocol-relative links
bool SafeMarkdownLink(const std::string& url) {
  if (std::any_of(url.begin(), url.end(), [](unsigned char value) {
        return value <= 0x20 || value == 0x7f || value == '\\';
      }))
    return false;
  if (url.empty() || url.starts_with('#')) return true;
  if (url.starts_with('/')) return !url.starts_with("//");
  auto lower = url;
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char value) {
                   return static_cast<char>(std::tolower(value));
                 });
  return lower.starts_with("https://") || lower.starts_with("http://") ||
         lower.starts_with("mailto:");
}

// Rebuild references on the server, ignoring client reference fields
bool MarkdownReferences(const Json::Value& input, Json::Value& references) {
  if (!input.isObject() || !input["content"].isString() ||
      !input["choices"].isArray() || input["choices"].size() > 100)
    return false;
  std::set<std::pair<int, std::string>> found;
  if (input["content"].asString().size() > 80000 ||
      !ReadSource(input["content"].asString(), -1, found))
    return false;
  int position = 0;
  for (const auto& choice : input["choices"]) {
    if (!choice.isObject() || !choice["content"].isString() ||
        choice["content"].asString().size() > 20000 ||
        !ReadSource(choice["content"].asString(), position, found))
      return false;
    ++position;
  }
  references = Json::Value(Json::arrayValue);
  for (const auto& [index, id] : found) {
    Json::Value item;
    item["position"] = index;
    item["assetId"] = id;
    references.append(item);
  }
  return true;
}
}  // namespace vote_machine
