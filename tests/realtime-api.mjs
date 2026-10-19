import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const apiA = 'http://api:8080';
const apiB = process.env.API_B_ORIGIN;
// Keep credentials in headers and never print response bodies on failure
async function call(base, path, token, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return {status: response.status, data: await response.json()};
}
// Retry only startup readiness while the second replica starts
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`${apiB}/health/ready`)).ok) break;
  } catch {}
  assert(attempt < 60, 'Second API did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
// Parse a stream incrementally without waiting for its connection to close
async function stream(base, path, token) {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: {Authorization: `Bearer ${token}`},
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert(response.headers.get('content-type')?.startsWith('text/event-stream'));
  assert.match(response.headers.get('cache-control'), /no-store/);
  const events = [];
  let ended = false;
  let bytes = 0;
  const reader = response.body.getReader();
  const pumping = (async () => {
    let buffer = '';
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        bytes += value.length;
        buffer += new TextDecoder().decode(value);
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          events.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch {
    } finally {
      ended = true;
    }
  })();
  return {
    events,
    get ended() {
      return ended;
    },
    get bytes() {
      return bytes;
    },
    async next(type, after = 0, timeout = 18000) {
      const until = Date.now() + timeout;
      for (;;) {
        const found = events
          .slice(after)
          .find((event) => event.startsWith(`event: ${type}\n`));
        if (found) return found;
        assert(!ended, `Stream ended before ${type}`);
        assert(Date.now() < until, `Missing ${type} event`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    },
    async close() {
      controller.abort();
      await pumping;
    },
  };
}
const created = (await call(apiA, '/api/rooms', null, {name: 'Realtime'})).data;
const roomPath = `/api/rooms/${created.room.id}`;
const admin = (
  await call(apiA, `${roomPath}/session`, null, {token: created.adminToken})
).data.sessionToken;
assert.equal((await call(apiB, roomPath, admin)).status, 200);
let question = (
  await call(apiA, `${roomPath}/questions`, admin, {
    content: 'Live question',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: true,
    publication: 'after_answer',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: true,
    choices: [{content: 'Yes'}, {content: 'No'}],
  })
).data.question;
question = (
  await call(apiA, `${roomPath}/questions/${question.id}/lifecycle`, admin, {
    action: 'open',
    revision: question.revision,
  })
).data.question;
const link = (
  await call(apiA, `${roomPath}/links`, admin, {
    mode: 'personal',
    names: ['Live participant'],
  })
).data.links[0];
const token = (await call(apiA, `${roomPath}/links/${link.id}/secret`, admin))
  .data.token;
const participant = (
  await call(apiA, `/api/vote/${link.id}/session`, null, {token})
).data.sessionToken;
assert.equal((await call(apiB, `${roomPath}/events`, participant)).status, 401);
const live = await stream(apiB, `${roomPath}/events`, admin);
try {
  await live.next('ready');
  const after = live.events.length;
  const saved = await call(
    apiA,
    `/api/vote/${link.id}/answers/${question.id}`,
    participant,
    {
      requestId: randomUUID(),
      questionRevision: question.revision,
      ballotRevision: '0',
      choices: [question.choices[0].id],
    },
  );
  assert.equal(saved.status, 200);
  await live.next('change', after);
  assert.equal(
    (await call(apiB, `${roomPath}/results?question=${question.id}`, admin))
      .data.result.total,
    1,
  );
  for (const event of live.events) {
    assert(!event.includes(link.id));
    assert(!event.includes(participant));
    assert(!event.includes('choices'));
    assert(!event.includes('total'));
  }
  await live.next('ready');
} finally {
  await live.close();
}
// A fresh connection always reconciles changes made while it was absent
await call(apiA, roomPath, admin, {name: 'During disconnect'}, 'PATCH');
const reconnect = await stream(apiB, `${roomPath}/events`, admin);
try {
  await reconnect.next('ready');
  assert.equal(
    (await call(apiB, roomPath, admin)).data.room.name,
    'During disconnect',
  );
} finally {
  await reconnect.close();
}
const voting = await stream(apiB, `/api/vote/${link.id}/events`, participant);
try {
  await voting.next('ready');
  await call(
    apiA,
    `${roomPath}/links/${link.id}`,
    admin,
    {action: 'revoke'},
    'PATCH',
  );
  await voting.next('access');
} finally {
  await voting.close();
}
// A stopped reader can never accumulate unlimited application events
const bounded = await stream(apiB, `${roomPath}/events`, admin);
try {
  await bounded.next('ready');
  let heartbeat = false;
  for (let index = 0; index < 70 && !bounded.ended; index++) {
    await call(apiA, roomPath, admin, {name: `Bound ${index}`}, 'PATCH');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    heartbeat ||= bounded.events.some((event) =>
      event.startsWith(': heartbeat'),
    );
  }
  assert(bounded.ended, 'Stream event budget did not close the lease');
  assert(
    bounded.events.filter((event) => event.startsWith('event:')).length <= 64,
  );
  assert(bounded.bytes < 16384);
  assert(heartbeat, 'Heartbeat was not received');
} finally {
  await bounded.close();
}
console.log(
  'Realtime checks passed: cross-replica delivery, reconnect snapshots, revoke, heartbeat and bounded stream leases',
);
