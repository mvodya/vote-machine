import http from 'node:http';
import net from 'node:net';
import {createHash, timingSafeEqual} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const secret = /^[0-9a-f]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
// Trust forwarded addresses only from explicitly configured proxy networks
export function proxyNetworks(value = '') {
  const networks = new net.BlockList();
  for (const item of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address, prefix, extra] = item.split('/');
    const family = net.isIP(address);
    const bits =
      prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    if (
      extra !== undefined ||
      (prefix !== undefined && !/^\d+$/.test(prefix)) ||
      !family ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > (family === 4 ? 32 : 128)
    )
      throw new Error('Invalid trusted proxy network');
    networks.addSubnet(address, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return networks;
}
// Outside clients cannot choose the address used for shared request limits
export function clientAddress(request, networks) {
  let peer = request.socket.remoteAddress ?? 'unknown';
  if (peer.startsWith('::ffff:')) peer = peer.slice(7);
  const family = net.isIP(peer);
  if (family && networks.check(peer, family === 4 ? 'ipv4' : 'ipv6')) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !net.isIP(forwarded))
      throw new Error('Invalid forwarded address');
    return forwarded;
  }
  return peer;
}
// Never trust network headers supplied by an outside client
export function cleanHeaders(source, address, origin) {
  const headers = {...source};
  for (const key of Object.keys(headers))
    if (
      key.startsWith('x-forwarded-') ||
      key.startsWith('x-vm-') ||
      key === 'forwarded' ||
      key === 'x-real-ip'
    )
      delete headers[key];
  headers['x-forwarded-for'] = address;
  headers['x-forwarded-host'] = origin.host;
  headers['x-forwarded-proto'] = origin.protocol.slice(0, -1);
  return headers;
}
// Read one room-specific credential, not an unrelated browser cookie
export function requestContext(path, method, cookie, address) {
  const match = /^\/api\/(rooms|vote)\/([^/]+)/.exec(path);
  const identity = match && uuid.test(match[2]) ? match[2] : '';
  const role = identity ? (match[1] === 'rooms' ? 'admin' : 'vote') : 'public';
  const name = role === 'admin' ? `vm_room_${identity}` : `vm_vote_${identity}`;
  let token = '';
  for (const part of (cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      const raw = value.join('=');
      token =
        role === 'admin'
          ? JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')).token
          : raw;
    } catch {}
  }
  return {
    network: digest(`network:${address}`),
    identity,
    role,
    session:
      typeof token === 'string' && secret.test(token) ? digest(token) : '',
    action:
      method === 'POST' && path === '/api/rooms'
        ? 'create'
        : ['GET', 'HEAD'].includes(method)
          ? 'read'
          : 'write',
  };
}
// Proxy streams without buffering files or SSE responses
export function createIngress({
  targetPort,
  apiOrigin,
  gatewayKey,
  publicOrigin,
  trustedProxies = '',
  onError = () => {},
  onRecord = () => {},
}) {
  if (!secret.test(gatewayKey ?? ''))
    throw new Error('API gateway key is missing');
  const configured = publicOrigin ? new URL(publicOrigin) : null;
  if (trustedProxies && !configured)
    throw new Error('Trusted proxies need PUBLIC_ORIGIN');
  const networks = proxyNetworks(trustedProxies);
  const active = new Map();
  const upgrades = new Set();
  const totals = new Map();
  let running = 0;
  let draining = false;
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    running++;
    // Labels never contain IDs, queries, cookies or request bodies
    let category = 'page';
    const method = [
      'GET',
      'HEAD',
      'POST',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ].includes(req.method)
      ? req.method
      : 'OTHER';
    res.once('finish', () => {
      const milliseconds = Math.max(0, performance.now() - started);
      const key = `${method}|${res.statusCode}|${category}`;
      const total = totals.get(key) ?? {count: 0, seconds: 0};
      total.count++;
      total.seconds += milliseconds / 1000;
      totals.set(key, total);
      onRecord({
        service: 'web',
        event: 'request',
        method,
        category,
        status: res.statusCode,
        milliseconds: Math.round(milliseconds),
      });
    });
    res.once('close', () => {
      running--;
    });
    const pending = {req, res, upstream: null, stream: false};
    active.set(res, pending);
    res.on('close', () => active.delete(res));
    // Stop admission when the caller leaves during an upload
    const aborted = new AbortController();
    req.on('aborted', () => aborted.abort());
    req.on('error', () => {
      aborted.abort();
      res.destroy();
    });
    res.on('close', () => aborted.abort());
    const fail = (status, retry) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        ...(retry ? {'Retry-After': String(retry)} : {}),
      });
      res.end(
        JSON.stringify({
          error:
            status === 429 ? 'Too many requests' : 'Service is unavailable',
        }),
      );
    };
    try {
      if (draining) {
        fail(503);
        return;
      }
      if (!req.url || req.url.length > 8192) {
        fail(414);
        return;
      }
      if (
        !req.url.startsWith('/') ||
        req.url.startsWith('//') ||
        req.url.includes('\\')
      ) {
        fail(400);
        return;
      }
      const origin = configured ?? new URL(`http://${req.headers.host}`);
      if (
        configured &&
        req.headers.host !== configured.host &&
        req.url !== '/api/health'
      ) {
        fail(400);
        return;
      }
      const address = clientAddress(req, networks);
      const path = decodeURIComponent(new URL(req.url, origin).pathname);
      if (path.includes('%') || path.startsWith('//')) {
        fail(400);
        return;
      }
      pending.stream = path.endsWith('/events');
      category = path.startsWith('/api/rooms')
        ? 'room'
        : path.startsWith('/api/vote')
          ? 'vote'
          : path.startsWith('/api/')
            ? 'api'
            : path.startsWith('/internal/')
              ? 'operations'
              : 'page';
      if (path === '/internal/metrics' || path === '/internal/ready') {
        const key = req.headers['x-vm-gateway'];
        if (
          typeof key !== 'string' ||
          !secret.test(key) ||
          !timingSafeEqual(Buffer.from(key), Buffer.from(gatewayKey))
        ) {
          fail(401);
          return;
        }
        if (path.endsWith('/ready')) {
          const ready = await fetch(new URL('/health/ready', apiOrigin), {
            signal: AbortSignal.timeout(3000),
          });
          await ready.arrayBuffer();
          res.writeHead(ready.ok ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({status: ready.ok ? 'ready' : 'unavailable'}));
        } else {
          let report =
            '# TYPE vm_http_inflight gauge\n' +
            `vm_http_inflight ${running}\n# TYPE vm_http_requests_total counter\n`;
          for (const [key, total] of totals) {
            const [method, status, route] = key.split('|');
            const label = `{method="${method}",status="${status}",route="${route}"}`;
            report += `vm_http_requests_total${label} ${total.count}\nvm_http_seconds_sum${label} ${total.seconds}\n`;
          }
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4',
            'Cache-Control': 'no-store',
          });
          res.end(report);
        }
        return;
      }
      if (path.startsWith('/api/')) {
        const write = !['GET', 'HEAD'].includes(req.method);
        if (
          req.headers['sec-fetch-site'] === 'cross-site' ||
          (write && !req.headers.origin) ||
          (req.headers.origin &&
            new URL(req.headers.origin).origin !== origin.origin)
        ) {
          fail(403);
          return;
        }
        // Health checks contain no private data and must survive a DB outage
        if (path !== '/api/health' && path !== '/api/hello') {
          const context = requestContext(
            path,
            req.method,
            req.headers.cookie,
            address,
          );
          const admitted = await fetch(new URL('/api/admission', apiOrigin), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-VM-Gateway': gatewayKey,
            },
            body: JSON.stringify(context),
            signal: AbortSignal.any([
              AbortSignal.timeout(5000),
              aborted.signal,
            ]),
            redirect: 'error',
          });
          // Release the small internal reply before forwarding a request
          await admitted.arrayBuffer();
          if (!admitted.ok) {
            fail(
              admitted.status === 429 ? 429 : 503,
              admitted.headers.get('retry-after'),
            );
            return;
          }
        }
      }
      if (req.destroyed || res.destroyed) return;
      const headers = cleanHeaders(req.headers, address, origin);
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          // A closing stream must never destroy another request's socket
          agent: false,
          headers: {...headers, connection: 'close'},
        },
        (response) => {
          const replyHeaders = {...response.headers};
          delete replyHeaders.connection;
          res.writeHead(response.statusCode ?? 503, replyHeaders);
          response.on('error', () => res.destroy());
          response.pipe(res);
        },
      );
      pending.upstream = upstream;
      upstream.on('error', () => fail(503));
      res.on('close', () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      onError();
      fail(503);
    }
  });
  // Next.js development uses a same-origin WebSocket for hot reload
  server.on('upgrade', (req, socket, head) => {
    try {
      const origin = configured ?? new URL(`http://${req.headers.host}`);
      if (
        draining ||
        !req.headers.origin ||
        new URL(req.headers.origin).origin !== origin.origin
      ) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        const headers = cleanHeaders(
          req.headers,
          req.socket.remoteAddress ?? 'unknown',
          origin,
        );
        upstream.write(
          `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\r\n')}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upgrades.add(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => {
        upgrades.delete(socket);
        upstream.destroy();
      });
    } catch {
      socket.destroy();
    }
  });
  // Finish commands before stopping the framework, reconnect streams elsewhere
  server.drain = (timeout = 10000) => {
    draining = true;
    // Node does not close upgraded hot-reload sockets with normal HTTP clients
    for (const socket of upgrades) socket.destroy();
    return new Promise((resolve) => {
      const limit = setTimeout(() => server.closeAllConnections(), timeout);
      server.close(() => {
        clearTimeout(limit);
        resolve();
      });
      server.closeIdleConnections();
      for (const pending of active.values()) {
        if (pending.stream) {
          pending.res.end();
          pending.upstream?.destroy();
        }
      }
    });
  };
  return server;
}
// Keep existing development environments usable after an upgrade
export function gatewayKey(env) {
  return (
    env.API_GATEWAY_KEY ??
    (env.ADMIN_LINK_KEY
      ? digest(`vote-machine:gateway:${env.ADMIN_LINK_KEY}`)
      : '')
  );
}
