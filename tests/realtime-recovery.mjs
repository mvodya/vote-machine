import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const origin = process.env.TEST_BASE_URL;
// Only restart the disposable database selected by the test harness
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
}
let cookie = '';
// Keep the same browser session across the outage
async function call(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      Connection: 'close',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (response.headers.getSetCookie().length)
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  return {response, data: await response.json()};
}
const created = await call('/api/rooms', {name: 'Live recovery'});
const {room, adminToken} = created.data;
await call(`/api/rooms/${room.id}/session`, {token: adminToken});
const path = `/api/rooms/${room.id}`;
// Read one named event without buffering a whole connection
async function open() {
  const controller = new AbortController();
  const response = await fetch(origin + path + '/events', {
    headers: {Cookie: cookie},
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = '';
  return {
    async event(type) {
      const deadline = Date.now() + 12000;
      for (;;) {
        if (buffer.includes(`event: ${type}\n`)) {
          buffer = '';
          return;
        }
        assert(Date.now() < deadline, 'Live recovery timed out');
        const next = await Promise.race([
          reader.read(),
          delay(12000).then(() => {
            throw new Error('Live recovery timed out');
          }),
        ]);
        assert(!next.done, 'Live stream ended early');
        buffer += new TextDecoder().decode(next.value);
      }
    },
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {}
    },
  };
}
const first = await open();
await first.event('ready');
await first.close();
compose('restart', 'postgres');
for (let attempt = 0; ; attempt++) {
  try {
    if ((await call(path)).response.ok) break;
  } catch {}
  assert(attempt < 40, 'Database did not recover');
  await delay(500);
}
// The existing API listener must reconnect without restarting the API
const restored = await open();
try {
  await restored.event('ready');
  const changed = await call(path, {name: 'Restored live room'}, 'PATCH');
  assert.equal(changed.response.status, 200);
  await restored.event('change');
  assert.equal((await call(path)).data.room.name, 'Restored live room');
} finally {
  await restored.close();
}
console.log(
  'Live recovery passed: database restart, retained session and reconnected listener',
);
// Check a clean shutdown on the replica that handled the long streams
const replica = `${project}-api-b`;
execFileSync('docker', ['stop', '--time', '10', replica], {
  encoding: 'utf8',
  timeout: 30000,
});
assert.equal(
  execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.ExitCode}}', replica],
    {encoding: 'utf8'},
  ).trim(),
  '0',
);
const logs = execFileSync('docker', ['logs', replica], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.doesNotMatch(
  logs,
  /ERROR: (AddressSanitizer|LeakSanitizer)|SUMMARY: (AddressSanitizer|UndefinedBehaviorSanitizer)|runtime error:/,
);
