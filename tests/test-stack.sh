#!/bin/sh
set -eu
# Use a disposable encryption key only for the isolated test stack
export ADMIN_LINK_KEY=1111111111111111111111111111111111111111111111111111111111111111
export API_GATEWAY_KEY=6666666666666666666666666666666666666666666666666666666666666666
export MEDIA_WORKER_KEY=2222222222222222222222222222222222222222222222222222222222222222
export GARAGE_RPC_SECRET=3333333333333333333333333333333333333333333333333333333333333333
export S3_ACCESS_KEY=GK44444444444444444444444444444444
export S3_SECRET_KEY=5555555555555555555555555555555555555555555555555555555555555555
export S3_ENDPOINT=http://garage:3900
export S3_BUCKET=votebox-assets
export S3_REGION=garage
export COMPOSE_PROFILES=local-storage
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
node --test tests/ingress.test.mjs
docker compose -p "$COMPOSE_PROJECT_NAME" up --build --wait --wait-timeout 180
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T web node --input-type=module < tests/rooms-api.mjs
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T web node --input-type=module < tests/links-api.mjs
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T web node --input-type=module < tests/questions-api.mjs
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T web node --input-type=module < tests/media-api.mjs
node tests/assets-cleanup.mjs
node tests/lifecycle-recovery.mjs
# Start a second API against the same database for live delivery checks
docker compose -p "$COMPOSE_PROJECT_NAME" run -d --no-deps --name "$COMPOSE_PROJECT_NAME-api-b" api
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T -e API_B_ORIGIN="http://$COMPOSE_PROJECT_NAME-api-b:8080" web node --input-type=module < tests/realtime-api.mjs
node tests/security-api.mjs
node tests/realtime-recovery.mjs
docker rm -f "$COMPOSE_PROJECT_NAME-api-b"
pnpm test:e2e
node tests/stack.mjs
