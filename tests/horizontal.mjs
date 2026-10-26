import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const origin = process.env.PUBLIC_ORIGIN;
// Outages affect only this disposable project
function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
  }).trim();
}
function compose(...args) {
  return docker('compose', '-p', project, ...args);
}
function replicas(service) {
  return compose('ps', '-q', service).split('\n').filter(Boolean);
}
// Keep secrets in headers and never include replies in assertion messages
async function call(path, body, cookie = '', method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      Connection: 'close',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, `Horizontal request failed with ${response.status}`);
  return {
    data: await response.json(),
    response,
    cookie: response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; '),
  };
}
// Recover through the balance pool instead of pinning a new session
async function recovered(path, cookie) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await call(path, undefined, cookie);
    } catch {
      await delay(300);
    }
  }
  assert.fail('The remaining replica did not recover');
}
const webs = replicas('web');
const apis = replicas('api');
assert.equal(webs.length, 2);
assert.equal(apis.length, 2);
const {
  data: {room, adminToken},
} = await call('/api/rooms', {name: 'Horizontal deployment'});
const path = `/api/rooms/${room.id}`;
const session = await call(path + '/session', {token: adminToken});
assert.match(session.response.headers.getSetCookie().join(' '), /Secure/i);
const admin = session.cookie;
for (let count = 0; count < 24; count++) await call(path, undefined, admin);
// Real private uploads must remain readable through every web replica
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC',
  'base64',
);
const form = new FormData();
form.set('file', new Blob([png], {type: 'image/png'}), 'shared.png');
const uploaded = await fetch(origin + path + '/assets', {
  method: 'POST',
  headers: {Origin: origin, Cookie: admin},
  body: form,
});
assert.equal(uploaded.status, 201);
const asset = await uploaded.json();
for (let count = 0; count < 8; count++) {
  const image = await fetch(origin + path + `/assets/${asset.id}`, {
    headers: {Cookie: admin},
  });
  assert.equal(image.status, 200);
  assert((await image.arrayBuffer()).byteLength > 0);
}
const {
  data: {question: draft},
} = await call(
  path + '/questions',
  {
    content: `Shared ![Image](${asset.source})`,
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: true,
    publication: 'after_answer',
    hideResultsUntilEnd: false,
    allowAnswerChange: true,
    anonymous: false,
    choices: [{content: 'Yes'}, {content: 'No'}],
  },
  admin,
);
const {
  data: {question},
} = await call(
  `${path}/questions/${draft.id}/lifecycle`,
  {action: 'open', revision: draft.revision},
  admin,
);
const {
  data: {
    links: [link],
  },
} = await call(
  path + '/links',
  {mode: 'personal', names: ['Horizontal voter']},
  admin,
);
const {
  data: {token},
} = await call(`${path}/links/${link.id}/secret`, undefined, admin);
const {cookie: voter} = await call(`/api/vote/${link.id}/session`, {token});
// A live stream must cross both balance pools without response buffering
const abort = new AbortController();
const stream = await fetch(origin + path + '/events', {
  headers: {Cookie: admin},
  signal: abort.signal,
});
assert.equal(stream.status, 200);
const reader = stream.body.getReader();
await reader.read();
const answer = {
  questionRevision: question.revision,
  ballotRevision: '0',
  requestId: randomUUID(),
  choices: [question.choices[0].id],
};
const result = await call(
  `/api/vote/${link.id}/answers/${question.id}`,
  answer,
  voter,
);
assert(result.data);
await Promise.race([
  reader.read(),
  delay(10000).then(() => assert.fail('Balanced SSE did not update')),
]);
abort.abort();
// Both API timers may see the deadline, only one close may be committed
const {
  data: {question: timed},
} = await call(
  path + '/questions',
  {
    content: 'Concurrent deadline',
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
    anonymous: false,
    deadlineMode: 'duration',
    closeAfterSeconds: 3,
    choices: [{content: 'Yes'}, {content: 'No'}],
  },
  admin,
);
await call(
  `${path}/questions/${timed.id}/lifecycle`,
  {action: 'open', revision: timed.revision},
  admin,
);
let state = '';
for (let attempt = 0; attempt < 24 && state !== 'closed'; attempt++) {
  await delay(250);
  state = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-Atc',
    `SELECT state FROM questions WHERE id='${timed.id}'`,
  );
}
assert.equal(state, 'closed');
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
    `SELECT count(*) FROM room_sound_events WHERE room_id='${room.id}' AND kind='close'`,
  ),
  '1',
);
const connections = Number(
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
    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend'",
  ),
);
assert(
  connections <= 7,
  'API SQL pools exceeded two connections and one listener per replica',
);
// Balanced traffic must actually use every replica, including the internal API pool
const edge = replicas('edge')[0];
const logs = docker('logs', edge);
for (const container of [...webs, ...apis]) {
  const ip = docker(
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    container,
  );
  assert(logs.includes(ip + ':'), 'A replica received no balanced traffic');
}
const stoppedWeb = webs[0];
docker('stop', '--time', '20', stoppedWeb);
assert.equal((await recovered(path, admin)).data.room.id, room.id);
const stoppedApi = apis[0];
const apiIp = docker(
  'inspect',
  '-f',
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
  stoppedApi,
);
const drainScript = `const base='http://${apiIp}:8080'; const denied=await fetch(base+'/internal/drain',{method:'POST'}); if(denied.status!==401) process.exit(1); const reply=await fetch(base+'/internal/drain',{method:'POST',headers:{'X-VM-Gateway':process.env.API_GATEWAY_KEY}}); if(!reply.ok) process.exit(2); const ready=await fetch(base+'/health/ready'); if(ready.status!==503) process.exit(3);`;
docker('exec', webs[1], 'node', '--input-type=module', '-e', drainScript);
await delay(6000);
docker('stop', '--time', '20', stoppedApi);
assert.equal((await recovered(path, admin)).data.room.id, room.id);
// Exact retries still resolve to the saved answer after removing either replica
await call(`/api/vote/${link.id}/answers/${question.id}`, answer, voter);
const persisted = compose(
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'vote_machine',
  '-d',
  'vote_machine',
  '-Atc',
  `SELECT count(*) FROM ballots WHERE question_id='${question.id}'`,
);
assert.equal(persisted, '1');
for (const container of [stoppedWeb, stoppedApi]) docker('start', container);
await recovered(path, admin);
console.log(
  'Horizontal TLS, shared sessions/media, balance, SSE, removal and retry checks passed',
);
