import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
// Never run a cleanup integration check against the working stack
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  }).trim();
}
// Keep the failure and retry phases deterministic
compose('stop', 'asset-cleanup');
// State output contains generated IDs only, never cookies or storage keys
const state = JSON.parse(
  compose(
    'exec',
    '-T',
    'web',
    'node',
    '--input-type=module',
    '-e',
    "import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));console.log(JSON.stringify({questionId:s.questionId,linkId:s.linkId,assets:s.assets.map(a=>a.id)}))",
  ),
);
for (const id of [state.questionId, state.linkId, ...state.assets])
  assert.match(id, /^[0-9a-f-]{36}$/);
// Only isolated fixture IDs enter SQL text
function sql(query) {
  return compose(
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
    '-Atc',
    query,
  );
}
sql(
  `UPDATE questions SET state='open' WHERE id='${state.questionId}'; UPDATE assets SET unused_since=statement_timestamp()-interval '25 hours' WHERE id IN (${state.assets.map((id) => `'${id}'`).join(',')});`,
);
// A real participant may read an open question asset, but no unattached file
compose(
  'exec',
  '-T',
  'web',
  'node',
  '--input-type=module',
  '-e',
  "import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));const r=await fetch('http://localhost:3000/api/vote/'+s.linkId+'/assets/'+s.keptId,{headers:{Cookie:s.participantCookie}});if(r.status!==200)throw Error('Published media denied');await r.arrayBuffer();",
);
// Recreate the storage container to check the persistent object volume
compose('stop', 'garage');
try {
  compose(
    'exec',
    '-T',
    'web',
    'node',
    '--input-type=module',
    '-e',
    "import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));const r=await fetch('http://localhost:3000/api/vote/'+s.linkId+'/assets/'+s.keptId,{headers:{Cookie:s.participantCookie},signal:AbortSignal.timeout(15000)});if(r.status!==503)throw Error('Storage outage was not reported');",
  );
} finally {
  compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'garage');
}
compose(
  'exec',
  '-T',
  'web',
  'node',
  '--input-type=module',
  '-e',
  "import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));const r=await fetch('http://localhost:3000/api/vote/'+s.linkId+'/assets/'+s.keptId,{headers:{Cookie:s.participantCookie},signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error('Stored object did not survive restart');await r.arrayBuffer();",
);
// An unavailable storage endpoint must not acknowledge deletion
compose(
  'exec',
  '-T',
  '-e',
  'S3_ENDPOINT=http://127.0.0.1:1',
  'web',
  'node',
  '--input-type=module',
  '-e',
  "import{cleanOnce}from'/app/apps/web/scripts/clean-assets.mjs';await cleanOnce();",
);
assert.equal(
  Number(
    sql(
      `SELECT count(*) FROM assets WHERE state='deleting' AND id IN (${state.assets.map((id) => `'${id}'`).join(',')});`,
    ),
  ),
  state.assets.length - 1,
);
sql(
  `UPDATE assets SET cleanup_until=statement_timestamp()-interval '1 second' WHERE state='deleting' AND id IN (${state.assets.map((id) => `'${id}'`).join(',')});`,
);
// A restarted real worker claims expired leases and removes the objects
compose('start', 'asset-cleanup');
const expected = state.assets.length - 1;
for (let attempt = 0; attempt < 50; attempt++) {
  const remaining = Number(
    sql(
      `SELECT count(*) FROM assets WHERE id IN (${state.assets.map((id) => `'${id}'`).join(',')});`,
    ),
  );
  if (remaining === 1) break;
  if (attempt === 49) assert.fail('Unused media was not cleaned');
  await delay(100);
}
// Verify real object deletion, not only removal of metadata
compose(
  'exec',
  '-T',
  'web',
  'node',
  '--input-type=module',
  '-e',
  "import{readFile}from'node:fs/promises';import{getObject}from'/app/apps/web/lib/server/storage.mjs';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));for(const a of s.assets){try{const r=await getObject(a.key);if(a.id!==s.keptId)throw Error('Unused object remains');await r.Body.transformToByteArray();}catch(e){if(a.id===s.keptId||e?.$metadata?.httpStatusCode!==404)throw Error('Storage cleanup failed');}}",
);
sql(
  `UPDATE voting_links SET revoked_at=statement_timestamp() WHERE id='${state.linkId}';`,
);
compose(
  'exec',
  '-T',
  'web',
  'node',
  '--input-type=module',
  '-e',
  "import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile('/tmp/votebox-media-test-state.json','utf8'));const r=await fetch('http://localhost:3000/api/vote/'+s.linkId+'/assets/'+s.keptId,{headers:{Cookie:s.participantCookie}});if(r.status!==401)throw Error('Revoked session still reads media');",
);
console.log(
  `Asset cleanup checks passed: ${expected} real unused objects removed, referenced media kept, revoked sessions blocked`,
);
