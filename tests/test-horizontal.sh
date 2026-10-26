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
  if [ -n "${TLS_TEST_DIR:-}" ]; then rm -rf "$TLS_TEST_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export COMPOSE_FILE=compose.yaml:compose.production.yaml
export PUBLIC_ORIGIN=https://127.0.0.1:3443
export HTTPS_PORT=3443
export HTTP_PORT=3180
export EDGE_BIND=127.0.0.1
export APP_SUBNET=172.31.71.0/24
export EDGE_ADDRESS=172.31.71.254
TLS_TEST_DIR=$(mktemp -d /tmp/votebox-tls.XXXXXX)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_TEST_DIR/key.pem" -out "$TLS_TEST_DIR/cert.pem" -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
export TLS_CERT_FILE="$TLS_TEST_DIR/cert.pem"
export TLS_KEY_FILE="$TLS_TEST_DIR/key.pem"
export NODE_EXTRA_CA_CERTS="$TLS_CERT_FILE"
node --test tests/ingress.test.mjs
docker compose -p "$COMPOSE_PROJECT_NAME" up --build --wait --wait-timeout 180
node tests/horizontal.mjs
echo 'Stage 17 horizontal deployment checks passed'
