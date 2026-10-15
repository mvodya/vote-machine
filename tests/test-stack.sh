#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="vote-machine-check-$$"
export WEB_PORT="${TEST_WEB_PORT:-3100}"
export TEST_BASE_URL="http://127.0.0.1:$WEB_PORT"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -p "$COMPOSE_PROJECT_NAME" logs --no-color
  fi
  docker compose -p "$COMPOSE_PROJECT_NAME" down --volumes --remove-orphans
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
docker compose -p "$COMPOSE_PROJECT_NAME" up --build --wait --wait-timeout 180
pnpm test:e2e
node tests/stack.mjs
