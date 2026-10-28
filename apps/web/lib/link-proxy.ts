import {NextResponse} from 'next/server';
import {roomIdPattern, secretPattern, validName} from './rooms';
import {savedRooms, sameOrigin} from './recent-rooms';
import {
  isRecord,
  isVotingLink,
  publicLink,
  isParticipant,
  validCursor,
  type Participant,
} from './voting-links';

const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
// Hide API error details at the browser boundary
function failure(status: number) {
  return NextResponse.json(
    {error: status === 401 ? 'Access required' : 'Request failed'},
    {status, headers},
  );
}
// Check and bound JSON before reading its fields
async function input(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 128 * 1024)
    throw new RangeError('Body too large');
  return JSON.parse(text);
}
// Writes use same-site JSON requests
function writeAllowed(request: Request) {
  if (!sameOrigin(request)) return failure(403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return failure(415);
  return null;
}
// Use only the fields needed by the participant page
function publicParticipant(value: Participant) {
  return {
    roomId: value.roomId,
    roomName: value.roomName,
    linkId: value.linkId,
    name: value.name,
    mode: value.mode,
  };
}
// Forward one admin link action using this room's saved session
export async function adminLinkProxy(
  request: Request,
  room: string,
  id?: string,
  secret = false,
) {
  if (
    !roomIdPattern.test(room) ||
    (id !== undefined && !roomIdPattern.test(id))
  )
    return failure(401);
  const token = savedRooms(request).find((entry) => entry.id === room)?.token;
  if (!token) return failure(401);
  const changing = request.method !== 'GET';
  if (changing) {
    const rejected = writeAllowed(request);
    if (rejected) return rejected;
  }
  try {
    let body: Record<string, unknown> | undefined;
    const query = new URL(request.url).searchParams;
    const after = query.get('after') ?? '0';
    const exporting = query.get('export') === '1';
    if (!validCursor(after)) return failure(400);
    if (changing) {
      const data = await input(request);
      if (!isRecord(data)) return failure(400);
      if (request.method === 'POST') {
        if (
          (data.mode !== 'personal' && data.mode !== 'reusable') ||
          !Array.isArray(data.names) ||
          data.names.length < 1 ||
          data.names.length > 100 ||
          !data.names.every(validName)
        )
          return failure(400);
        body = {mode: data.mode, names: data.names};
      } else {
        if (
          !id ||
          !['rename', 'revoke', 'rotate'].includes(String(data.action))
        )
          return failure(400);
        if (
          data.action === 'rename' &&
          (!validName(data.name) ||
            (data.allowRunHistory !== undefined &&
              typeof data.allowRunHistory !== 'boolean'))
        )
          return failure(400);
        body = {
          action: data.action,
          ...(data.action === 'rename'
            ? {
                name: data.name,
                ...(data.allowRunHistory !== undefined
                  ? {allowRunHistory: data.allowRunHistory}
                  : {}),
              }
            : {}),
        };
      }
    }
    const path = `/api/rooms/${room}/links${id ? `/${id}${secret ? '/secret' : ''}` : `?${new URLSearchParams({after, export: exporting ? '1' : '0'})}`}`;
    const upstream = await fetch(
      new URL(path, process.env.API_ORIGIN ?? 'http://api:8080'),
      {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok)
      return failure(
        [400, 401, 404, 409, 413, 415].includes(upstream.status)
          ? upstream.status
          : 503,
      );
    const data: unknown = await upstream.json();
    if (!isRecord(data)) return failure(502);
    if (secret) {
      if (typeof data.token !== 'string' || !secretPattern.test(data.token))
        return failure(502);
      return NextResponse.json({token: data.token}, {headers});
    }
    if (id) {
      if (!isVotingLink(data.link) || data.link.id !== id) return failure(502);
      return NextResponse.json({link: publicLink(data.link)}, {headers});
    }
    if (!Array.isArray(data.links) || !data.links.every(isVotingLink))
      return failure(502);
    const links = [];
    for (const link of data.links) {
      const value: Record<string, unknown> = {...publicLink(link)};
      const source = link as unknown as Record<string, unknown>;
      if (exporting && !changing) {
        if (
          !link.revoked &&
          (typeof source.token !== 'string' ||
            !secretPattern.test(source.token))
        )
          return failure(502);
        value.token = link.revoked ? null : source.token;
      }
      links.push(value);
    }
    if (
      !changing &&
      data.nextCursor !== null &&
      (!validCursor(data.nextCursor) || data.nextCursor === '0')
    )
      return failure(502);
    return NextResponse.json(
      {links, ...(!changing ? {nextCursor: data.nextCursor} : {})},
      {status: changing ? 201 : 200, headers},
    );
  } catch (error) {
    return failure(
      error instanceof RangeError
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 503,
    );
  }
}
// Participant cookies never use the admin room cookie names
export function votingCookie(id: string) {
  return `vm_vote_${id}`;
}
// Exchange a participant link or check its separate saved session
export async function participantProxy(
  request: Request,
  id: string,
  exchange = false,
) {
  if (!roomIdPattern.test(id)) return failure(401);
  if (exchange) {
    const rejected = writeAllowed(request);
    if (rejected) return rejected;
  }
  try {
    let body: Record<string, unknown> | undefined;
    const outgoing: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (exchange) {
      const data = await input(request);
      if (
        !isRecord(data) ||
        typeof data.token !== 'string' ||
        !secretPattern.test(data.token)
      )
        return failure(401);
      body = {token: data.token};
      const prior = request.headers
        .get('cookie')
        ?.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${votingCookie(id)}=`))
        ?.split('=')[1];
      if (prior && secretPattern.test(prior))
        outgoing.Authorization = `Bearer ${prior}`;
    } else {
      const token = request.headers
        .get('cookie')
        ?.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${votingCookie(id)}=`))
        ?.split('=')[1];
      if (!token || !secretPattern.test(token)) return failure(401);
      outgoing.Authorization = `Bearer ${token}`;
    }
    const upstream = await fetch(
      new URL(
        `/api/vote/${id}${exchange ? '/session' : ''}`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: exchange ? 'POST' : 'GET',
        headers: outgoing,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok) return failure(upstream.status === 401 ? 401 : 503);
    const data: unknown = await upstream.json();
    if (
      !isRecord(data) ||
      !isParticipant(data.participant) ||
      data.participant.linkId !== id
    )
      return failure(502);
    const response = NextResponse.json(
      {participant: publicParticipant(data.participant)},
      {headers},
    );
    if (exchange) {
      if (
        typeof data.sessionToken !== 'string' ||
        !secretPattern.test(data.sessionToken)
      )
        return failure(502);
      response.cookies.set(votingCookie(id), data.sessionToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure:
          new URL(request.url).protocol === 'https:' ||
          request.headers.get('x-forwarded-proto') === 'https',
        path: `/api/vote/${id}`,
        expires: new Date('9999-12-31T23:59:59Z'),
      });
    }
    return response;
  } catch (error) {
    return failure(
      error instanceof RangeError
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 503,
    );
  }
}
