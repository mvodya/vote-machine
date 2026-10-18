import assert from 'node:assert/strict';

// Call only the isolated API and never print session keys
async function call(path, {method = 'GET', body, token} = {}) {
  const response = await fetch(`http://api:8080${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.match(response.headers.get('cache-control'), /no-store/);
  return {status: response.status, data: await response.json()};
}
// Create a room with its own independent admin session
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
    path: `/api/rooms/${room.id}/questions`,
    policy: `/api/rooms/${room.id}/question-policy`,
  };
}
// Supply all settings even for an empty draft
function document(extra = {}) {
  return {
    content: '',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    choices: [],
    ...extra,
  };
}
const owner = await admin('Question API');
const other = await admin('Other questions');
const {path, token} = owner;
for (const credential of [undefined, other.token])
  assert.equal((await call(path, {token: credential})).status, 401);
assert.deepEqual((await call(path, {token})).data, {
  questions: [],
  nextCursor: null,
});
for (const body of [
  document({maxChoices: 2}),
  document({content: 'x'.repeat(20001)}),
  document({content: '\0'}),
  document({choices: [{content: 'x'.repeat(5001)}]}),
  document({minChoices: 1.5}),
])
  assert.equal((await call(path, {method: 'POST', token, body})).status, 400);
const created = await call(path, {
  method: 'POST',
  token,
  body: document({
    content: 'Choose',
    choices: [{content: 'A'}, {content: 'B'}],
    state: 'draft',
  }),
});
assert.equal(created.status, 201);
const q = created.data.question;
assert.equal(q.state, 'draft');
assert.equal(q.editLocked, null);
assert.equal(q.choices.length, 2);
assert.equal(
  (await call(`${other.path}/${q.id}`, {token: other.token})).status,
  404,
);
assert.equal(
  (
    await call(`${other.path}/${q.id}`, {
      method: 'DELETE',
      token: other.token,
      body: {revision: q.revision},
    })
  ).status,
  404,
);
const ownOther = (
  await call(path, {
    method: 'POST',
    token,
    body: document({choices: [{content: 'Other'}]}),
  })
).data.question;
assert.equal(
  (
    await call(`${path}/${q.id}`, {
      method: 'PATCH',
      token,
      body: {...q, choices: [ownOther.choices[0]]},
    })
  ).status,
  400,
);
assert.deepEqual((await call(`${path}/${q.id}`, {token})).data.question, q);
const edited = await call(`${path}/${q.id}`, {
  method: 'PATCH',
  token,
  body: {
    ...q,
    content: 'New',
    choices: [q.choices[1], q.choices[0]],
    choiceMode: 'multiple',
    maxChoices: 2,
    shareResults: true,
    publication: 'after_answer',
  },
});
assert.equal(edited.status, 200);
assert.equal(edited.data.question.choices[0].id, q.choices[1].id);
assert.equal(edited.data.question.choiceMode, 'multiple');
assert.equal(edited.data.question.createdAt, q.createdAt);
assert.equal(
  (await call(`${path}/${q.id}`, {method: 'PATCH', token, body: q})).status,
  409,
);
assert.equal(
  (
    await call(`${path}/${q.id}`, {
      method: 'DELETE',
      token,
      body: {revision: q.revision},
    })
  ).status,
  409,
);
const current = edited.data.question;
const races = await Promise.all([
  call(`${path}/${q.id}`, {
    method: 'PATCH',
    token,
    body: {...current, content: 'One'},
  }),
  call(`${path}/${q.id}`, {
    method: 'PATCH',
    token,
    body: {...current, content: 'Two'},
  }),
]);
assert.deepEqual(races.map((reply) => reply.status).sort(), [200, 409]);
const latest = (await call(`${path}/${q.id}`, {token})).data.question;
assert.equal(
  (
    await call(`${path}/${q.id}`, {
      method: 'DELETE',
      token,
      body: {revision: latest.revision},
    })
  ).status,
  200,
);
assert.equal((await call(`${path}/${q.id}`, {token})).status, 404);
let policy = (await call(owner.policy, {token})).data.policy;
assert.equal(policy.lockAfterOpen, true);
const changed = await call(owner.policy, {
  method: 'PATCH',
  token,
  body: {...policy, lockAfterOpen: false},
});
assert.equal(changed.status, 200);
assert.equal(changed.data.policy.lockAfterOpen, false);
assert.equal(
  (
    await call(owner.policy, {
      method: 'PATCH',
      token,
      body: {...policy, lockAfterOpen: true},
    })
  ).status,
  409,
);
assert.equal((await call(owner.policy, {token: other.token})).status, 401);
// A full valid draft is larger than the old request limit
const large = await call(path, {
  method: 'POST',
  token,
  body: document({
    content: 'Q'.repeat(20000),
    choices: Array.from({length: 100}, (_, index) => ({
      content: String(index).padEnd(5000, 'x'),
    })),
    choiceMode: 'multiple',
    maxChoices: 100,
  }),
});
assert.equal(large.status, 201);
assert.equal(large.data.question.choices.length, 100);
for (let index = 0; index < 51; index++)
  assert.equal(
    (
      await call(path, {
        method: 'POST',
        token,
        body: document({content: `Page ${index}`}),
      })
    ).status,
    201,
  );
const first = (await call(path, {token})).data;
assert.equal(first.questions.length, 50);
assert(first.nextCursor);
assert(
  first.questions.every((item) => !('choices' in item) && !('content' in item)),
);
const second = (
  await call(`${path}?${new URLSearchParams({after: first.nextCursor})}`, {
    token,
  })
).data;
assert.equal(second.questions.length, 3);
assert.equal(second.nextCursor, null);
assert.equal((await call(`${path}?after=bad`, {token})).status, 400);
const link = (
  await call(`/api/rooms/${owner.room.id}/links`, {
    method: 'POST',
    token,
    body: {mode: 'personal', names: ['Participant']},
  })
).data.links[0];
const key = (
  await call(`/api/rooms/${owner.room.id}/links/${link.id}/secret`, {token})
).data.token;
const vote = (
  await call(`/api/vote/${link.id}/session`, {
    method: 'POST',
    body: {token: key},
  })
).data;
assert.equal((await call(path, {token: vote.sessionToken})).status, 401);
assert.equal(
  (await call(`${path}/${large.data.question.id}`, {token: vote.sessionToken}))
    .status,
  401,
);
assert.equal(
  (await call(owner.policy, {token: vote.sessionToken})).status,
  401,
);
console.log('Question API checks passed');
