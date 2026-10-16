#!/bin/sh
set -eu
cd "$(dirname "$0")/../apps/api"
cmake --preset dev
cmake --build --preset dev --parallel 2
find src tests -name '*.cpp' -exec clang-tidy -p ../../build/api {} +
