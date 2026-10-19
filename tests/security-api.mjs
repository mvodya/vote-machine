import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^vote-machine-check-[0-9]+$/);
const origin = process.env.TEST_BASE_URL;
// Touch only the disposable test database
function sql(text) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'vote_machine',
      '-d',
      'vote_machine',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {input: text, encoding: 'utf8'},
  ).trim();
}
// Keep secrets out of command arguments and logs
function internal(script) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      'exec',
      '-T',
      'web',
      'node',
      '--input-type=module',
    ],
    {input: script, encoding: 'utf8'},
  ).trim();
}
const created = await fetch(origin + '/api/rooms', {
  method: 'POST',
  headers: {Origin: origin, 'Content-Type': 'application/json'},
  body: JSON.stringify({name: 'Admission checks'}),
});
assert.equal(created.status, 201);
const {room, adminToken} = await created.json();
const exchanged = await fetch(origin + `/api/rooms/${room.id}/session`, {
  method: 'POST',
  headers: {Origin: origin, 'Content-Type': 'application/json'},
  body: JSON.stringify({token: adminToken}),
});
assert.equal(exchanged.status, 200);
const cookie = exchanged.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
// Exhaust creation without blocking an existing audience
const network = sql(
  "SELECT encode(key_hash,'hex') FROM request_limits WHERE scope='create' ORDER BY updated_at DESC LIMIT 1;",
);
assert.match(network, /^[0-9a-f]{64}$/);
try {
  sql(
    `UPDATE request_limits SET tokens=0,updated_at=clock_timestamp() WHERE scope='create' AND key_hash=decode('${network}','hex');`,
  );
  for (const forged of ['10.1.2.3', '203.0.113.8']) {
    const blocked = await fetch(origin + '/api/rooms', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Forwarded-For': forged,
        'X-VM-Gateway': 'fake',
      },
      body: '{}',
    });
    assert.equal(blocked.status, 429);
    assert(Number(blocked.headers.get('retry-after')) > 0);
    assert.match(blocked.headers.get('cache-control'), /no-store/);
    assert(!JSON.stringify(await blocked.json()).includes(adminToken));
  }
  const allowed = await fetch(origin + `/api/rooms/${room.id}`, {
    headers: {Cookie: cookie},
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('cache-control'), /no-store/);
} finally {
  sql(
    `DELETE FROM request_limits WHERE scope='create' AND key_hash=decode('${network}','hex');`,
  );
}
// Seed a small remaining budget and race two real API replicas
const name = `vm_room_${room.id}`;
const raw = cookie
  .split('; ')
  .find((value) => value.startsWith(name + '='))
  .slice(name.length + 1);
const token = JSON.parse(Buffer.from(raw, 'base64url').toString()).token;
const hash = createHash('sha256').update(token).digest('hex');
try {
  sql(
    `INSERT INTO request_limits(scope,key_hash,tokens,updated_at) VALUES('session_write',decode('${hash}','hex'),4,clock_timestamp()+interval '30 seconds') ON CONFLICT(scope,key_hash) DO UPDATE SET tokens=4,updated_at=excluded.updated_at;`,
  );
  const code = `
    import assert from 'node:assert/strict';
    const body=${JSON.stringify({network: '7'.repeat(64), identity: room.id, session: hash, role: 'admin', action: 'write'})};
    const origins=['http://api:8080','http://${project}-api-b:8080'];
    const denied=await fetch(origins[0]+'/api/admission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(denied.status,401);
    const invalid=await fetch(origins[0]+'/api/admission',{method:'POST',headers:{'Content-Type':'application/json','X-VM-Gateway':process.env.API_GATEWAY_KEY},body:JSON.stringify({...body,identity:[]})});
    assert.equal(invalid.status,400);
    const responses=await Promise.all(Array.from({length:10},(_,index)=>fetch(origins[index%2]+'/api/admission',{method:'POST',headers:{'Content-Type':'application/json','X-VM-Gateway':process.env.API_GATEWAY_KEY},body:JSON.stringify(body)})));
    assert.equal(responses.filter(value=>value.status===200).length,4);
    assert.equal(responses.filter(value=>value.status===429).length,6);
    for(const response of responses.filter(value=>value.status===429)) assert(Number(response.headers.get('retry-after'))>0);
    console.log('Cross-replica HTTP admission passed');`;
  assert.match(internal(code), /Cross-replica HTTP admission passed/);
} finally {
  sql(`DELETE FROM request_limits WHERE key_hash=decode('${hash}','hex');`);
}
console.log(
  'Security checks passed: trusted address, shared budgets, audience access and private replies',
);
