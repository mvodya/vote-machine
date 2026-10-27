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

// A proxy may supply one address only after its peer network is trusted
test('forwarded addresses require an explicit proxy network and public origin', async () => {
  const {proxyNetworks, clientAddress} =
    await import('../apps/web/lib/server/ingress.mjs');
  const request = {
    socket: {remoteAddress: '::ffff:127.0.0.1'},
    headers: {'x-forwarded-for': '192.0.2.42'},
  };
  assert.equal(clientAddress(request, proxyNetworks()), '127.0.0.1');
  assert.equal(
    clientAddress(request, proxyNetworks('127.0.0.1/32')),
    '192.0.2.42',
  );
  assert.throws(() =>
    clientAddress(
      {...request, headers: {'x-forwarded-for': '192.0.2.1, 192.0.2.2'}},
      proxyNetworks('127.0.0.1'),
    ),
  );
  for (const value of ['bad', '127.0.0.1/33', '::1/129', '127.0.0.1/2/3'])
    assert.throws(() => proxyNetworks(value));
  assert.throws(() =>
    createIngress({
      targetPort: 1,
      apiOrigin: 'http://api',
      gatewayKey: '6'.repeat(64),
      trustedProxies: '127.0.0.1',
    }),
  );
});

// A deploy lets commands finish while streams reconnect on another replica
test('draining finishes an in-flight command and closes an open event stream', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const target = http.createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write('data: ready\n\n');
      return;
    }
    entered();
    await delay(80);
    res.end('saved');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const ingress = createIngress({
    targetPort: target.address().port,
    apiOrigin: 'http://unused',
    gatewayKey: '6'.repeat(64),
  });
  await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ingress.address().port}`;
  try {
    const events = await fetch(origin + '/events');
    const reader = events.body.getReader();
    await reader.read();
    const command = fetch(origin + '/slow', {
      method: 'POST',
      body: 'answer',
    }).then((response) => response.text());
    await started;
    const drained = ingress.drain(1000);
    assert.equal(await command, 'saved');
    assert.equal((await reader.read()).done, true);
    await drained;
  } finally {
    ingress.closeAllConnections();
    ingress.close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  }
});

// Operator data is authenticated and logs cannot contain private request details
test('draining closes upgraded hot-reload sockets before waiting for HTTP shutdown', async () => {
  const sockets = new Set();
  const target = http.createServer();
  target.on('upgrade', (_request, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const ingress = createIngress({
    targetPort: target.address().port,
    apiOrigin: 'http://unused',
    gatewayKey: '6'.repeat(64),
  });
  await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ingress.address().port}`;
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const request = http.request(origin, {
        headers: {Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket'},
      });
      request.on('upgrade', (_response, upgraded) => resolve(upgraded));
      request.on('error', reject);
      request.end();
    });
    socket.on('error', () => {});
    socket.resume();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await Promise.race([
      ingress.drain(100),
      delay(1500).then(() => assert.fail('Hot reload blocked drain')),
    ]);
    await closed;
  } finally {
    socket?.destroy();
    sockets.forEach((item) => item.destroy());
    ingress.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test('metrics and structured records have bounded labels and redact private input', async () => {
  const records = [];
  const target = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const ingress = createIngress({
    targetPort: target.address().port,
    apiOrigin: 'http://unused',
    gatewayKey: '6'.repeat(64),
    onRecord: (record) => records.push(record),
  });
  await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ingress.address().port}`;
  try {
    await (
      await fetch(origin + '/private-secret?token=never-log-this', {
        headers: {Cookie: 'private-cookie'},
      })
    ).text();
    assert.equal((await fetch(origin + '/internal/metrics')).status, 401);
    const response = await fetch(origin + '/internal/metrics', {
      headers: {'X-VM-Gateway': '6'.repeat(64)},
    });
    assert.equal(response.status, 200);
    const metrics = await response.text();
    assert.match(metrics, /vm_http_requests_total/);
    for (const text of [JSON.stringify(records), metrics]) {
      assert(!text.includes('never-log-this'));
      assert(!text.includes('private-secret'));
      assert(!text.includes('private-cookie'));
      assert(!text.includes('6'.repeat(64)));
    }
  } finally {
    ingress.closeAllConnections();
    ingress.close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  }
});
