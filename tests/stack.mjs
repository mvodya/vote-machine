import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl);

function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  }).trim();
}

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

try {
  compose('stop', 'postgres');
  assert.deepEqual(await hello(503), {error: 'Service is unavailable'});
  assert.equal(apiStatus('/health/live'), '200');
  assert.equal(apiStatus('/health/ready'), '503');
} finally {
  compose('start', 'postgres');
}
await waitForReady();
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

try {
  compose('stop', 'api');
  assert.deepEqual(await hello(503), {error: 'Service is unavailable'});
} finally {
  compose('start', 'api');
}
await waitForReady();
compose('stop', 'api');
const apiContainer = compose('ps', '--all', '--quiet', 'api');
assert.equal(
  execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.ExitCode}}', apiContainer],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  ).trim(),
  '0',
);
const apiLogs = compose('logs', '--no-color', 'api');
assert.doesNotMatch(apiLogs, /creating path .*Permission denied/);
assert.doesNotMatch(
  apiLogs,
  /ERROR: (AddressSanitizer|LeakSanitizer)|SUMMARY: (AddressSanitizer|UndefinedBehaviorSanitizer)|runtime error:/,
);
console.log(
  'Stack checks passed: real DB, no-cache, failures, recovery, persistence',
);
