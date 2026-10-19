import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {
  cleanHeaders,
  requestContext,
  createIngress,
} from '../apps/web/lib/server/ingress.mjs';
import {createHash} from 'node:crypto';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
const digest = (value) => createHash('sha256').update(value).digest('hex');
test('ingress removes spoofed network headers and isolates room credentials', () => {
  const headers = cleanHeaders(
    {
      'x-forwarded-for': 'forged',
      'x-vm-gateway': 'forged',
      forwarded: 'forged',
      host: 'localhost',
    },
    '127.0.0.1',
    new URL('http://localhost'),
  );
  assert.equal(headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(headers['x-vm-gateway'], undefined);
  assert.equal(headers.forwarded, undefined);
  const cookie = `vm_vote_${id}=${token}`;
  const context = requestContext(
    `/api/vote/${id}/answers`,
    'POST',
    cookie,
    '127.0.0.1',
  );
  assert.equal(context.session, digest(token));
  assert.equal(context.role, 'vote');
  assert.equal(
    requestContext(`/api/rooms/${id}/questions`, 'GET', cookie, '127.0.0.1')
      .session,
    '',
  );
});
// Use real sockets to check trusted peer handling and admission ordering
test('the public ingress rejects cross-site writes before its admission call', async () => {
  let calls = 0;
  let wait = 0;
  let closedStream = false;
  const api = http.createServer(async (req, res) => {
    calls++;
    let data = '';
    for await (const chunk of req) data += chunk;
    assert.equal(JSON.parse(data).network, digest('network:127.0.0.1'));
    assert.equal(req.headers['x-vm-gateway'], '6'.repeat(64));
    if (wait) await delay(wait);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end('{"allowed":true}');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const target = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write('event: ready\ndata: {}\n\n');
      res.on('close', () => {
        closedStream = true;
      });
      return;
    }
    res.end('ok');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const server = createIngress({
    targetPort: target.address().port,
    apiOrigin: `http://127.0.0.1:${api.address().port}`,
    gatewayKey: '6'.repeat(64),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (
        await fetch(origin + '/api/rooms', {
          method: 'POST',
          headers: {Origin: 'http://foreign'},
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await fetch(origin + '/api/rooms', {
          method: 'POST',
          headers: {Origin: origin, 'X-Forwarded-For': 'forged'},
        })
      ).status,
      200,
    );
    assert.equal(calls, 1);
    const controller = new AbortController();
    const stream = await fetch(origin + '/api/events', {
      signal: controller.signal,
    });
    await stream.body.getReader().read();
    controller.abort();
    for (let index = 0; index < 50 && !closedStream; index++) await delay(10);
    assert(closedStream, 'An abandoned stream kept its upstream connection');
    const reads = await Promise.all(
      Array.from({length: 10}, () => fetch(origin + '/api/recent-rooms')),
    );
    assert(reads.every((response) => response.status === 200));
    await Promise.all(reads.map((response) => response.text()));
    // Abort a body while admission is still waiting
    wait = 100;
    await new Promise((resolve) => {
      const pending = http.request(
        origin + '/api/rooms',
        {method: 'POST', headers: {Origin: origin, 'Content-Length': '100'}},
        () => {},
      );
      pending.on('error', resolve);
      pending.write('{');
      setTimeout(() => pending.destroy(), 20);
    });
    await delay(150);
    wait = 0;
    assert.equal((await fetch(origin + '/api/recent-rooms')).status, 200);
  } finally {
    for (const item of [server, target, api]) {
      item.closeAllConnections();
      await new Promise((resolve) => item.close(resolve));
    }
  }
});
