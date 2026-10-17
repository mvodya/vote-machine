import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

// Read the real Compose config without starting containers
function config(files) {
  const args = files.flatMap((file) => ['-f', file]);
  return JSON.parse(
    execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKSPACE_DB_PORT: '15432',
        ADMIN_LINK_KEY: '1'.repeat(64),
      },
      timeout: 10000,
    }),
  );
}

test('normal stack keeps PostgreSQL private and waits for migrations', () => {
  const services = config(['compose.yaml']).services;
  assert.deepEqual(services.postgres.ports ?? [], []);
  assert.equal(
    services.api.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(
    services.migrate.depends_on.postgres.condition,
    'service_healthy',
  );
});

test('devcontainer exposes PostgreSQL only on the host loopback', () => {
  const services = config([
    'compose.yaml',
    '.devcontainer/compose.yaml',
  ]).services;
  const ports = services.postgres.ports;
  assert.equal(ports.length, 1);
  assert.equal(ports[0].host_ip, '127.0.0.1');
  assert.equal(ports[0].published, '15432');
  assert.equal(ports[0].target, 5432);
  assert.equal(
    services.workspace.depends_on.migrate.condition,
    'service_completed_successfully',
  );
});
