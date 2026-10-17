#!/bin/sh
set -eu
# Use a disposable encryption key only for the isolated test stack
export ADMIN_LINK_KEY=1111111111111111111111111111111111111111111111111111111111111111
cd "$(dirname "$0")/.."
# Keep test containers separate from the working stack
export COMPOSE_PROJECT_NAME="vote-machine-check-$$"
export WEB_PORT="${TEST_WEB_PORT:-3100}"
export TEST_BASE_URL="http://127.0.0.1:$WEB_PORT"
# Remove only this test stack and its data
cleanup() {
  status=$?
  # Show logs when a check fails
  if [ "$status" -ne 0 ]; then
    docker compose -p "$COMPOSE_PROJECT_NAME" logs --no-color
  fi
  docker compose -p "$COMPOSE_PROJECT_NAME" down --volumes --remove-orphans
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
docker compose -p "$COMPOSE_PROJECT_NAME" up --build --wait --wait-timeout 180
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T web node --input-type=module < tests/rooms-api.mjs
pnpm test:e2e
node tests/stack.mjs
