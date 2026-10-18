import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const origin = process.env.TEST_BASE_URL;
// Restrict outages to this disposable project
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  }).trim();
}
// Read the persisted state without the effective-state projection
function stored(id) {
  assert.match(id, /^[0-9a-f-]{36}$/);
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-Atc',
    `SELECT state FROM questions WHERE id='${id}'`,
  );
}
// Use the same cookie and JSON flow as an admin browser
async function post(path, data, cookie = '') {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify(data),
  });
  assert(response.ok, `Lifecycle HTTP status ${response.status}`);
  return {
    body: await response.json(),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
const {
  body: {room, adminToken},
} = await post('/api/rooms', {name: 'Deadline recovery'});
const {cookie} = await post(`/api/rooms/${room.id}/session`, {
  token: adminToken,
});
const {
  body: {question},
} = await post(
  `/api/rooms/${room.id}/questions`,
  {
    content: 'Recovery',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    choices: [{content: 'A'}, {content: 'B'}],
  },
  cookie,
);
await post(
  `/api/rooms/${room.id}/questions/${question.id}/lifecycle`,
  {
    action: 'open',
    revision: question.revision,
    closesAt: new Date(Date.now() + 4000).toISOString(),
  },
  cookie,
);
compose('stop', 'api');
await delay(4200);
assert.equal(stored(question.id), 'open');
compose('start', 'api');
for (let attempt = 0; attempt < 30; attempt++) {
  if (stored(question.id) === 'closed') break;
  await delay(1000);
}
assert.equal(stored(question.id), 'closed');
console.log('Deadline recovery passed: overdue work resumes after API restart');
