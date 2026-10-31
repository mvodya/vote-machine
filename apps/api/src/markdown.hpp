// vote.machine.
// Copyright (c) 2026 Mark Vodyanitskiy
// SPDX-License-Identifier: MIT

#pragma once
#include <json/json.h>

#include <string>

namespace vote_machine {

// Read managed media references without treating code or HTML as images
bool MarkdownReferences(const Json::Value& input, Json::Value& references);
// Keep executable URL schemes out of stored Markdown links
bool SafeMarkdownLink(const std::string& url);

}  // namespace vote_machine
