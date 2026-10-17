#!/bin/sh
set -eu
cd "$(dirname "$0")/../apps/api"
# Build first so clang-tidy has the compile flags
cmake --preset dev
cmake --build --preset dev --parallel 2
# Check source files and tests
find src tests -name '*.cpp' -exec clang-tidy -p ../../build/api {} +
