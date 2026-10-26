import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {backup, restore} from '../scripts/backup.mjs';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const origin = process.env.TEST_BASE_URL;
// All destructive actions stay inside this disposable test project
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
}
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
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `Operations HTTP ${response.status}`);
  return {
    data: await response.json(),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await call('/api/hello');
      return;
    } catch {
      await delay(500);
    }
  }
  assert.fail('Restored application did not recover');
}
const {
  data: {room, adminToken},
} = await call('/api/rooms', {name: 'Restored private data'});
const path = `/api/rooms/${room.id}`;
const {cookie: admin} = await call(path + '/session', {token: adminToken});
const form = new FormData();
form.set(
  'file',
  new Blob(
    [
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC',
        'base64',
      ),
    ],
    {type: 'image/png'},
  ),
  'restore.png',
);
const upload = await fetch(origin + path + '/assets', {
  method: 'POST',
  headers: {Origin: origin, Cookie: admin},
  body: form,
});
assert.equal(upload.status, 201);
const asset = await upload.json();
const {
  data: {question: draft},
} = await call(
  path + '/questions',
  {
    content: `Backup ![Private](${asset.source})`,
    choiceMode: 'single',
    minChoices: 1,
    maxChoices: 1,
    shareResults: false,
    publication: 'after_close',
    hideResultsUntilEnd: false,
    allowAnswerChange: false,
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
  {mode: 'personal', names: ['Restored voter']},
  admin,
);
const {
  data: {token},
} = await call(`${path}/links/${link.id}/secret`, undefined, admin);
const {cookie: voter} = await call(`/api/vote/${link.id}/session`, {token});
const payload = {
  requestId: randomUUID(),
  questionRevision: question.revision,
  ballotRevision: '0',
  choices: [question.choices[0].id],
};
await call(`/api/vote/${link.id}/answers/${question.id}`, payload, voter);
const root = await mkdtemp(join(tmpdir(), 'votebox-restore-'));
try {
  const old = join(root, '2000-01-01T00-00-00-000Z-abcdef01');
  await mkdir(old);
  await writeFile(
    join(old, 'complete.json'),
    JSON.stringify({version: 1, createdAt: '2000-01-01T00:00:00Z'}),
  );
  const bucket = process.env.S3_BUCKET;
  process.env.S3_BUCKET = 'votebox-missing-backup-bucket';
  try {
    await assert.rejects(backup(root));
  } finally {
    process.env.S3_BUCKET = bucket;
  }
  await ready();
  const snapshot = await backup(root);
  await ready();
  const snapshots = await readdir(root);
  assert(snapshots.length > 0);
  assert(!snapshots.includes('2000-01-01T00-00-00-000Z-abcdef01'));
  const bytes = await readFile(join(snapshot, 'database.dump'));
  await writeFile(join(snapshot, 'database.dump'), Buffer.from('broken'));
  await assert.rejects(restore(snapshot, true));
  assert.equal((await call(path, undefined, admin)).data.room.id, room.id);
  await writeFile(join(snapshot, 'database.dump'), bytes);
  // Replace only test storage with an empty bucket before the verified restore
  compose('stop', 'web', 'api', 'asset-cleanup', 'garage');
  compose('rm', '-f', 'garage');
  execFileSync('docker', ['volume', 'rm', `${project}_garage_data`], {
    stdio: 'ignore',
  });
  compose('up', '-d', '--no-build', '--wait', 'garage');
  await restore(snapshot, true);
  await ready();
  assert.equal(
    (await call(path, undefined, admin)).data.room.name,
    'Restored private data',
  );
  // The old cookie and exact retry survive actual pg_restore
  await call(`/api/vote/${link.id}/answers/${question.id}`, payload, voter);
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
      `SELECT count(*) FROM ballots WHERE question_id='${question.id}'`,
    ),
    '1',
  );
  const image = await fetch(origin + path + `/assets/${asset.id}`, {
    headers: {Cookie: admin},
  });
  assert.equal(image.status, 200);
  assert((await image.arrayBuffer()).byteLength > 0);
  assert.equal(
    (await call(path + '/admin-link', undefined, admin)).data.adminToken,
    adminToken,
  );
  const logs = compose('logs', '--no-color', 'web');
  assert(!logs.includes(adminToken));
  assert(!logs.includes(token));
  const live = await call(path, undefined, admin);
  await call(
    path,
    {confirmation: room.id, revision: live.data.room.revision},
    admin,
    'DELETE',
  );
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'vote_machine',
    '-d',
    'vote_machine',
    '-c',
    `UPDATE object_deletions SET available_at=clock_timestamp()-interval '1 second' WHERE id='${asset.id}'`,
  );
  const cleanup = `import {cleanOnce} from './apps/web/scripts/clean-assets.mjs'; import {headObject} from './apps/web/lib/server/storage.mjs'; await cleanOnce(); try { await headObject('rooms/${room.id}/${asset.id}'); process.exit(1); } catch (error) { if(error?.$metadata?.httpStatusCode!==404) process.exit(2); console.log('Deleted room object was removed'); }`;
  compose('exec', '-T', 'web', 'node', '--input-type=module', '-e', cleanup);
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
      'SELECT count(*) FROM object_deletions',
    ),
    '0',
  );
  assert.equal((await fetch(origin + '/internal/metrics')).status, 401);
  const metrics = `const response=await fetch('http://api:8080/internal/metrics',{headers:{'X-VM-Gateway':process.env.API_GATEWAY_KEY}}); if(!response.ok || !(await response.text()).includes('vm_api_pool_limit')) process.exit(1);`;
  compose('exec', '-T', 'web', 'node', '--input-type=module', '-e', metrics);
  console.log(
    'Real database/object restore, checksums, sessions, votes, media and log redaction passed',
  );
} finally {
  await rm(root, {recursive: true, force: true});
}
