import {NextResponse} from 'next/server';
import {participantToken} from './ballot-proxy';
import {votingCookie} from './link-proxy';
import {savedRooms, sameOrigin} from './recent-rooms';
import {roomIdPattern, secretPattern, validName} from './rooms';
import {isRecord, validCursor} from './voting-links';
import {registrationMember, registrationStatus} from './registrations';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Keep errors small and free of private database fields
function fail(status: number, error = 'Request failed') {
  return NextResponse.json({error}, {status, headers});
}
// Check each cookie write before forwarding a request
function writable(request: Request) {
  return (
    sameOrigin(request) &&
    request.headers.get('content-type')?.split(';')[0] === 'application/json'
  );
}
// Exchange only this browser's approved identity for a scoped voting cookie
export async function registrationProxy(request: Request, group: string) {
  if (!roomIdPattern.test(group)) return fail(401);
  const token = participantToken(request, group);
  if (!token) return fail(401);
  let body;
  if (request.method === 'POST') {
    if (!writable(request)) return fail(403);
    try {
      const text = await request.text();
      if (text.length > 4096) return fail(413);
      const data = JSON.parse(text);
      if (!isRecord(data) || !validName(data.name) || !data.name.trim())
        return fail(400);
      body = {name: data.name};
    } catch {
      return fail(400);
    }
  }
  try {
    const response = await fetch(
      new URL(
        `/api/vote/${group}/registration`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      return fail(
        [400, 401, 409].includes(response.status) ? response.status : 503,
        ['same_name', 'registration_closed'].includes(String(data.error))
          ? data.error
          : 'Request failed',
      );
    const status = registrationStatus(data);
    if (!status) return fail(502);
    const result = NextResponse.json(status, {headers});
    if (status.votingId) {
      if (
        typeof data.sessionToken !== 'string' ||
        !secretPattern.test(data.sessionToken)
      )
        return fail(502);
      result.cookies.set(votingCookie(status.votingId), data.sessionToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure:
          new URL(request.url).protocol === 'https:' ||
          request.headers.get('x-forwarded-proto') === 'https',
        path: `/api/vote/${status.votingId}`,
        expires: new Date('9999-12-31T23:59:59Z'),
      });
    }
    return result;
  } catch {
    return fail(503);
  }
}
// Lists, moderation and recovery credentials all use the room admin cookie
export async function registrationAdminProxy(
  request: Request,
  room: string,
  group: string,
  member?: string,
  secret = false,
) {
  if (
    ![room, group, ...(member ? [member] : [])].every((id) =>
      roomIdPattern.test(id),
    )
  )
    return fail(401);
  const token = savedRooms(request).find((item) => item.id === room)?.token;
  if (!token) return fail(401);
  const params = new URL(request.url).searchParams;
  const after = params.get('after') ?? '0';
  const filter = params.get('filter') ?? 'registered';
  if (!validCursor(after) || !['registered', 'pending', 'all'].includes(filter))
    return fail(400);
  let body;
  if (request.method !== 'GET') {
    if (!writable(request)) return fail(403);
    try {
      const text = await request.text();
      if (text.length > 4096) return fail(413);
      const data = JSON.parse(text);
      if (
        !member ||
        !isRecord(data) ||
        !['approve', 'reject', 'block', 'unblock', 'call', 'rename'].includes(
          String(data.action),
        ) ||
        !validCursor(data.revision)
      )
        return fail(400);
      if (
        data.action === 'rename' &&
        (!validName(data.name) || !data.name.trim())
      )
        return fail(400);
      body = {
        action: data.action,
        revision: data.revision,
        ...(data.action === 'rename' ? {name: data.name} : {}),
      };
    } catch {
      return fail(400);
    }
  }
  try {
    const response = await fetch(
      new URL(
        `/api/rooms/${room}/links/${group}/members${member ? `/${member}${secret ? '/secret' : ''}` : `?${new URLSearchParams({after, filter})}`}`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      return fail(
        [400, 401, 404, 409].includes(response.status) ? response.status : 503,
      );
    if (secret) {
      if (
        !isRecord(data) ||
        typeof data.token !== 'string' ||
        !secretPattern.test(data.token)
      )
        return fail(502);
      return NextResponse.json({token: data.token}, {headers});
    }
    if (member) return NextResponse.json({ok: true}, {headers});
    if (
      !Array.isArray(data.members) ||
      data.members.length > 50 ||
      !Number.isSafeInteger(data.pendingCount) ||
      data.pendingCount < 0 ||
      !Number.isSafeInteger(data.registeredCount) ||
      data.registeredCount < 0 ||
      (data.nextCursor !== null && !validCursor(data.nextCursor))
    )
      return fail(502);
    const members = data.members.map((item: unknown) =>
      registrationMember(item, true),
    );
    if (members.some((item: unknown) => !item)) return fail(502);
    return NextResponse.json(
      {
        members,
        pendingCount: data.pendingCount,
        registeredCount: data.registeredCount,
        nextCursor: data.nextCursor,
      },
      {headers},
    );
  } catch {
    return fail(503);
  }
}
