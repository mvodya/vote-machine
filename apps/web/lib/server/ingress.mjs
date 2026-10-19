import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const secret = /^[0-9a-f]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
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
  onError = () => {},
}) {
  if (!secret.test(gatewayKey ?? ''))
    throw new Error('API gateway key is missing');
  const configured = publicOrigin ? new URL(publicOrigin) : null;
  const server = http.createServer(async (req, res) => {
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
      const path = decodeURIComponent(new URL(req.url, origin).pathname);
      if (path.includes('%') || path.startsWith('//')) {
        fail(400);
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
          let address = req.socket.remoteAddress ?? 'unknown';
          if (address.startsWith('::ffff:')) address = address.slice(7);
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
      const headers = cleanHeaders(
        req.headers,
        req.socket.remoteAddress ?? 'unknown',
        origin,
      );
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
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    } catch {
      socket.destroy();
    }
  });
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
