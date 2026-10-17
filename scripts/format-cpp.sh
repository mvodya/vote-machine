#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Check formatting unless --write is set
case "${1:---check}" in
  --check) find apps/api/src apps/api/tests -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror {} + ;;
  --write) find apps/api/src apps/api/tests -type f \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format -i {} + ;;
  *) echo 'Use --check or --write' >&2; exit 2 ;;
esac
