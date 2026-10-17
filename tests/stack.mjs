import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

// Use only the test project
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl);

// Run Docker commands for the test stack
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  }).trim();
}

// Check the web reply and its cache header
async function hello(status) {
  const response = await fetch(`${baseUrl}/api/hello`, {
    // Docker commands block the event loop while idle sockets can close
    headers: {Connection: 'close'},
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status);
  assert.match(response.headers.get('cache-control'), /no-store/);
  return response.json();
}

// Read the HTTP status from inside the API container
function apiStatus(path) {
  return compose(
    'exec',
    '-T',
    'api',
    'curl',
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '5',
    `http://localhost:8080${path}`,
  );
}

// Read the exit code of a stopped service
function exitCode(service) {
  const container = compose('ps', '--all', '--quiet', service);
  return execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.ExitCode}}', container],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  ).trim();
}

// Wait for the API and database to recover
async function waitForReady() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await hello(200);
      return;
    } catch {
      await delay(1000);
    }
  }
  throw new Error('Stack did not recover');
}

assert.deepEqual(await hello(200), {
  message: 'Hello world',
  database: 'connected',
});
assert.equal(apiStatus('/health/live'), '200');
assert.equal(apiStatus('/health/ready'), '200');
assert.equal(exitCode('migrate'), '0');
assert.equal(
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-Atc',
    "SELECT to_regclass('public.rooms') IS NOT NULL AND to_regclass('public.room_admin_credentials') IS NULL AND to_regclass('public.room_admin_sessions') IS NOT NULL",
  ),
  't',
);

// Readiness must reject a schema that does not match the running API
compose(
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'vote_machine',
  '-d',
  'vote_machine',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
  'ALTER FUNCTION vm_create_room(text, bytea, bytea) RENAME TO schema_probe',
);
try {
  assert.equal(apiStatus('/health/ready'), '503');
} finally {
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'ALTER FUNCTION schema_probe(text, bytea, bytea) RENAME TO vm_create_room',
  );
}
assert.equal(apiStatus('/health/ready'), '200');

// Keep an admin session across service and database restarts
const created = await fetch(`${baseUrl}/api/rooms`, {
  method: 'POST',
  headers: {
    Origin: new URL(baseUrl).origin,
    'Content-Type': 'application/json',
    Connection: 'close',
  },
  body: JSON.stringify({name: 'Persistent room'}),
});
assert.equal(created.status, 201);
const {room, adminToken} = await created.json();
const exchanged = await fetch(`${baseUrl}/api/rooms/${room.id}/session`, {
  method: 'POST',
  headers: {
    Origin: new URL(baseUrl).origin,
    'Content-Type': 'application/json',
    Connection: 'close',
  },
  body: JSON.stringify({token: adminToken}),
});
assert.equal(exchanged.status, 200);
const adminCookie = exchanged.headers.get('set-cookie').split(';')[0];

// A restored API must use the same shared database session
async function adminRoom(status) {
  const response = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
    headers: {Cookie: adminCookie, Connection: 'close'},
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json();
  if (status === 200) assert.deepEqual(body, {room});
}
await adminRoom(200);

// Save a value to check after the database restarts
compose(
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'vote_machine',
  '-d',
  'vote_machine',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
  "CREATE TABLE stage1_probe (value text); INSERT INTO stage1_probe VALUES ('kept')",
);

// Check the error reply while the database is down
try {
  compose('stop', 'postgres');
  assert.deepEqual(await hello(503), {error: 'Service is unavailable'});
  await adminRoom(503);
  assert.equal(apiStatus('/health/live'), '200');
  assert.equal(apiStatus('/health/ready'), '503');
} finally {
  compose('start', 'postgres');
}
await waitForReady();
await adminRoom(200);
assert.equal(
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-tAc',
    'SELECT value FROM stage1_probe',
  ),
  'kept',
);

// Check the error reply while the API is down
try {
  compose('stop', 'api');
  assert.deepEqual(await hello(503), {error: 'Service is unavailable'});
  await adminRoom(503);
} finally {
  compose('start', 'api');
}
await waitForReady();
await adminRoom(200);
// Check a clean exit and look for runtime errors
compose('stop', 'api');
assert.equal(exitCode('api'), '0');
const apiLogs = compose('logs', '--no-color', 'api');
assert.doesNotMatch(apiLogs, /creating path .*Permission denied/);
assert.doesNotMatch(
  apiLogs,
  /ERROR: (AddressSanitizer|LeakSanitizer)|SUMMARY: (AddressSanitizer|UndefinedBehaviorSanitizer)|runtime error:/,
);
console.log(
  'Stack checks passed: real DB, no-cache, failures, recovery, persistence',
);
