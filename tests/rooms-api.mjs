import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

// Run inside the isolated test web container
const base = 'http://api:8080';

// Read only public fields, without printing test secrets
async function call(path, {method = 'GET', body, token, cookie} = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.match(response.headers.get('cache-control'), /no-store/);
  return {status: response.status, data: await response.json()};
}

// Create two rooms and use independent sessions for the first
const created = await call('/api/rooms', {
  method: 'POST',
  body: {name: 'API room'},
});
assert.equal(created.status, 201);
const {room, adminToken} = created.data;
assert.deepEqual(Object.keys(room).sort(), [
  'createdAt',
  'id',
  'name',
  'revision',
]);
assert.match(adminToken, /^[0-9a-f]{64}$/);
const other = (await call('/api/rooms', {method: 'POST', body: {}})).data;
const path = `/api/rooms/${room.id}`;
const tokens = [];
for (let index = 0; index < 2; index++) {
  const opened = await call(`${path}/session`, {
    method: 'POST',
    body: {token: adminToken},
  });
  assert.equal(opened.status, 200);
  assert.match(opened.data.sessionToken, /^[0-9a-f]{64}$/);
  assert.notEqual(opened.data.sessionToken, adminToken);
  tokens.push(opened.data.sessionToken);
}
assert.notEqual(tokens[0], tokens[1]);
for (const token of tokens) {
  const response = await call(path, {token});
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {room});
  const link = await call(`${path}/admin-link`, {token});
  assert.equal(link.status, 200);
  assert.deepEqual(link.data, {adminToken});
  assert.equal(
    (await call(`/api/rooms/${other.room.id}/admin-link`, {token})).status,
    401,
  );
  assert.equal(
    (await call(`/api/rooms/${other.room.id}`, {token})).status,
    401,
  );
  assert.equal(
    (
      await call(`/api/rooms/${other.room.id}`, {
        method: 'PATCH',
        body: {name: 'hacked'},
        token,
      })
    ).status,
    401,
  );
}

// A link key is not a session, and ambient browser cookies do not authorize the API
for (const token of [
  undefined,
  '',
  'invalid',
  adminToken,
  randomBytes(32).toString('hex'),
]) {
  assert.equal((await call(path, {token})).status, 401);
  assert.equal((await call(`${path}/admin-link`, {token})).status, 401);
}
assert.equal(
  (
    await call(path, {
      cookie: `vm_admin_${room.id.replaceAll('-', '')}=${tokens[0]}`,
    })
  ).status,
  401,
);
for (const token of ['', 'x'.repeat(64), randomBytes(32).toString('hex')]) {
  assert.equal(
    (await call(`${path}/session`, {method: 'POST', body: {token}})).status,
    401,
  );
}
assert.equal(
  (
    await call(`/api/rooms/${other.room.id}/session`, {
      method: 'POST',
      body: {token: adminToken},
    })
  ).status,
  401,
);
assert.equal(
  (await call('/api/rooms/not-a-uuid', {token: tokens[0]})).status,
  401,
);

// Both the API and PostgreSQL enforce input limits
for (const name of [null, 42, 'a'.repeat(201), '\0']) {
  assert.equal(
    (await call('/api/rooms', {method: 'POST', body: {name}})).status,
    400,
  );
  assert.equal(
    (await call(path, {method: 'PATCH', token: tokens[0], body: {name}}))
      .status,
    400,
  );
}
const renamed = await call(path, {
  method: 'PATCH',
  token: tokens[0],
  body: {name: '  Renamed  '},
});
assert.equal(renamed.status, 200);
assert.equal(renamed.data.room.name, 'Renamed');
assert.equal(renamed.data.room.revision, '1');
assert.equal((await call(path, {token: tokens[1]})).data.room.name, 'Renamed');
assert.equal(
  (await call(`/api/rooms/${other.room.id}`, {token: tokens[0]})).status,
  401,
);
console.log(
  'Room API checks passed: creation, hashes, independent sessions, room isolation and validation',
);
