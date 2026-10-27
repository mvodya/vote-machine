import assert from 'node:assert/strict';

// Call only the isolated test API and never print test keys
async function call(path, {method = 'GET', body, token} = {}) {
  const response = await fetch(`http://api:8080${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.match(response.headers.get('cache-control'), /no-store/);
  return {status: response.status, data: await response.json()};
}
// Create independent admin sessions for access checks
async function admin(name) {
  const {room, adminToken} = (
    await call('/api/rooms', {method: 'POST', body: {name}})
  ).data;
  const {sessionToken} = (
    await call(`/api/rooms/${room.id}/session`, {
      method: 'POST',
      body: {token: adminToken},
    })
  ).data;
  return {
    room,
    token: sessionToken,
    adminToken,
    path: `/api/rooms/${room.id}/links`,
  };
}
const owner = await admin('Links API');
const other = await admin('Other room');
const {path, token} = owner;
for (const credential of [undefined, owner.adminToken, other.token])
  assert.equal((await call(path, {token: credential})).status, 401);
for (const body of [
  {mode: 'other', names: ['A']},
  {mode: 'personal', names: []},
  {mode: 'personal', names: ['Good', 'x'.repeat(201)]},
  {mode: 'personal', names: Array(101).fill('A')},
])
  assert.equal((await call(path, {method: 'POST', token, body})).status, 400);
assert.deepEqual((await call(path, {token})).data, {
  links: [],
  nextCursor: null,
});
const created = await call(path, {
  method: 'POST',
  token,
  body: {mode: 'personal', names: ['Alice', 'Bob']},
});
assert.equal(created.status, 201);
const [link] = created.data.links;
assert.deepEqual(Object.keys(link).sort(), [
  'id',
  'mode',
  'name',
  'ordinal',
  'revision',
  'revoked',
  'sessionCount',
]);
const secretPath = `${path}/${link.id}/secret`;
const secret = (await call(secretPath, {token})).data.token;
assert.match(secret, /^[0-9a-f]{64}$/);
assert.equal((await call(secretPath, {token})).data.token, secret);
assert.equal(
  (await call(`${other.path}/${link.id}/secret`, {token: other.token})).status,
  404,
);
assert.equal(
  (
    await call(`${other.path}/${link.id}`, {
      method: 'PATCH',
      token: other.token,
      body: {action: 'revoke'},
    })
  ).status,
  404,
);
assert.equal(
  (
    await call(`${path}/${link.id}`, {
      method: 'PATCH',
      token,
      body: {action: 'change-mode', mode: 'reusable'},
    })
  ).status,
  400,
);
const votePath = `/api/vote/${link.id}`;
assert.equal(
  (await call(`${votePath}/session`, {method: 'POST', body: {token}})).status,
  401,
);
const session = (
  await call(`${votePath}/session`, {method: 'POST', body: {token: secret}})
).data;
assert.deepEqual(Object.keys(session.participant).sort(), [
  'linkId',
  'mode',
  'name',
  'roomId',
  'roomName',
]);
assert.equal(session.participant.roomId, owner.room.id);
assert.equal(session.participant.mode, 'personal');
assert.equal((await call(votePath, {token: session.sessionToken})).status, 200);
assert.equal((await call(path, {token: session.sessionToken})).status, 401);
assert.equal(
  (await call(secretPath, {token: session.sessionToken})).status,
  401,
);
assert.equal((await call(votePath, {token})).status, 401);
assert.equal(
  (
    await call(`/api/vote/${created.data.links[1].id}`, {
      token: session.sessionToken,
    })
  ).status,
  401,
);
await call(`${path}/${link.id}`, {
  method: 'PATCH',
  token,
  body: {action: 'rename', name: 'New Alice'},
});
assert.equal(
  (await call(votePath, {token: session.sessionToken})).data.participant.name,
  'New Alice',
);
assert.equal((await call(secretPath, {token})).data.token, secret);
await call(`${path}/${link.id}`, {
  method: 'PATCH',
  token,
  body: {action: 'revoke'},
});
assert.equal((await call(votePath, {token: session.sessionToken})).status, 401);
assert.equal(
  (await call(`${votePath}/session`, {method: 'POST', body: {token: secret}}))
    .status,
  401,
);
assert.equal((await call(secretPath, {token})).status, 404);
const exported = (await call(`${path}?export=1`, {token})).data.links;
assert.equal(exported.find((row) => row.id === link.id).token, null);
const rotated = await call(`${path}/${link.id}`, {
  method: 'PATCH',
  token,
  body: {action: 'rotate'},
});
assert.equal(rotated.data.link.id, link.id);
assert.equal(rotated.data.link.name, 'New Alice');
assert.equal(rotated.data.link.revoked, false);
const replacement = (await call(secretPath, {token})).data.token;
assert.notEqual(replacement, secret);
assert.equal(
  (await call(`${votePath}/session`, {method: 'POST', body: {token: secret}}))
    .status,
  401,
);
assert.equal(
  (
    await call(`${votePath}/session`, {
      method: 'POST',
      body: {token: replacement},
    })
  ).status,
  200,
);
assert.equal((await call(votePath, {token: session.sessionToken})).status, 401);
const bulk = await call(path, {
  method: 'POST',
  token,
  body: {
    mode: 'reusable',
    names: Array.from({length: 100}, (_, index) => `Shared ${index}`),
  },
});
assert.equal(bulk.status, 201);
assert.equal(bulk.data.links.length, 100);
const shared = bulk.data.links[0];
const sharedKey = (await call(`${path}/${shared.id}/secret`, {token})).data
  .token;
for (let i = 0; i < 2; i++)
  assert.equal(
    (
      await call(`/api/vote/${shared.id}/session`, {
        method: 'POST',
        body: {token: sharedKey},
      })
    ).data.participant.mode,
    'reusable',
  );
const ids = new Set();
let cursor = '0';
while (true) {
  const page = await call(`${path}?after=${cursor}`, {token});
  assert.equal(page.status, 200);
  assert(page.data.links.length <= 50);
  for (const row of page.data.links) {
    assert(!ids.has(row.id));
    ids.add(row.id);
    assert(!('token' in row));
  }
  if (page.data.nextCursor === null) break;
  cursor = page.data.nextCursor;
}
assert.equal(ids.size, 102);
assert.equal(
  (await call(`${path}?after=9223372036854775808`, {token})).status,
  400,
);
console.log('Participant link API checks passed');
