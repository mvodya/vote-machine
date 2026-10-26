#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Use only the active disposable test project
case "${COMPOSE_PROJECT_NAME:-}" in
  vote-machine-check-[0-9]*) ;;
  *) echo 'Run this helper inside a disposable stack check' >&2; exit 1 ;;
esac
mkdir -p apps/web/test-results
# The official Linux browser avoids local macOS profile launch failures
docker run --rm --init --network "${COMPOSE_PROJECT_NAME}_default" \
  -e TEST_BASE_URL=http://web:3000 \
  -v "$PWD:/workspace:ro" -v "$PWD/apps/web/test-results:/results" -w /workspace \
  mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f \
  node tests/firefox-runner.mjs
