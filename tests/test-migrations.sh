#!/bin/sh
set -eu
# Use a disposable encryption key only for the isolated test stack
export ADMIN_LINK_KEY=1111111111111111111111111111111111111111111111111111111111111111
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="vote-machine-migrations-check-$$"
fixture_dir=$(mktemp -d)

# Run commands only in the test project
compose() {
  docker compose -f compose.yaml -p "$COMPOSE_PROJECT_NAME" "$@"
}

# Remove test containers, data and migration files
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose logs --no-color
  fi
  compose down --volumes --remove-orphans
  rm -rf "$fixture_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
node --test tests/compose.test.mjs
compose up -d --wait postgres
compose build migrate
compose run --rm --no-deps -e MIGRATION_TESTS=1 migrate node --test tests/migrate.test.mjs

# A failed migration must block API startup
mkdir "$fixture_dir/migrations"
chmod 755 "$fixture_dir" "$fixture_dir/migrations"
cat > "$fixture_dir/migrations/1792800000000-failure.mjs" <<'MIGRATION'
export function up(pgm) {
  pgm.sql('CREATE TABLE failed_release (id integer); SELECT 1 / 0;');
}
export const down = false;
MIGRATION
node - "$fixture_dir" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify({
  services: {migrate: {volumes: [{
    type: 'bind',
    source: path.join(root, 'migrations'),
    target: '/app/db/migrations',
    read_only: true,
  }]}},
}));
JS
if docker compose -f compose.yaml -f "$fixture_dir/compose.json" -p "$COMPOSE_PROJECT_NAME" up --build --wait --wait-timeout 90 api; then
  echo 'A failed migration allowed API startup' >&2
  exit 1
fi
api_id=$(compose ps --all --quiet api)
if [ -n "$api_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$api_id")" = true ]; then
  echo 'API started before migrations finished' >&2
  exit 1
fi
migration_id=$(compose ps --all --quiet migrate)
test "$(docker inspect --format '{{.State.ExitCode}}' "$migration_id")" -ne 0

# The normal image should recover without failed schema changes
compose up -d --no-build --wait --wait-timeout 90 api
compose exec -T api curl --fail --silent http://localhost:8080/health/ready
compose exec -T postgres psql -U vote_machine -d vote_machine -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF (SELECT count(*) FROM schema_migrations) <> $(find db/migrations -name '*.mjs' | wc -l | tr -d ' ') OR to_regclass('public.failed_release') IS NOT NULL THEN RAISE EXCEPTION 'Bad migration state'; END IF; END \$\$;"
echo 'Migration checks passed: schema, upgrade, rollback, locks and startup gate'
