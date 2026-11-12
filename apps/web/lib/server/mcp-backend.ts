import {secretPattern} from '../rooms';
import {gatewayKey} from './ingress.mjs';

// Keep credentials and private replies out of caches and referrers
export const mcpHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

// Use the public origin set by the deployment or the trusted ingress
export function publicOrigin(request: Request) {
  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) return new URL(configured).origin;
  const host = request.headers.get('x-forwarded-host');
  const proto = request.headers.get('x-forwarded-proto');
  if (host && (proto === 'https' || proto === 'http'))
    return new URL(`${proto}://${host}`).origin;
  return new URL(request.url).origin;
}

// Read an agent credential only from the Authorization header
export function bearer(request: Request) {
  const value = request.headers
    .get('authorization')
    ?.match(/^Bearer (.+)$/i)?.[1];
  return value && secretPattern.test(value) ? value : null;
}

// Keep every grant check in the private API
export async function mcpBackend(
  channel: 'token' | 'operation',
  room: string,
  credential: string | null,
  action: string,
  data: Record<string, unknown> = {},
) {
  return fetch(
    new URL(
      `/internal/mcp/${channel}`,
      process.env.API_ORIGIN ?? 'http://api:8080',
    ),
    {
      method: 'POST',
      headers: {
        'X-VM-Gateway': gatewayKey(process.env),
        'Content-Type': 'application/json',
        ...(credential ? {Authorization: `Bearer ${credential}`} : {}),
      },
      body: JSON.stringify({room, action, data}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
  );
}

// Bound request bodies before JSON parsing or decoding files
export async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new RangeError('Request is too large');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError('Request is too large');
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, size);
}
