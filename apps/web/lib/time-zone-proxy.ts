import {NextResponse} from 'next/server';
import {isRoom, roomIdPattern} from './rooms';
import {savedRooms, sameOrigin, rememberRoom} from './recent-rooms';
import {isRecord, validCursor} from './voting-links';
import {validTimeZone} from './time';

const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Save only an allowed room zone through this admin session
export async function timeZoneProxy(request: Request, id: string) {
  const token = savedRooms(request).find((room) => room.id === id)?.token;
  if (!roomIdPattern.test(id) || !token)
    return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
  if (!sameOrigin(request))
    return NextResponse.json({error: 'Origin denied'}, {status: 403, headers});
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return NextResponse.json({error: 'JSON required'}, {status: 415, headers});
  try {
    const source = await request.text();
    if (source.length > 4096)
      return NextResponse.json({error: 'Too large'}, {status: 413, headers});
    const data: unknown = JSON.parse(source);
    if (
      !isRecord(data) ||
      !validTimeZone(data.timeZone) ||
      (data.initialize !== true && !validCursor(data.revision))
    )
      return NextResponse.json({error: 'Invalid zone'}, {status: 400, headers});
    const upstream = await fetch(
      new URL(
        `/api/rooms/${id}/time-zone`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          timeZone: data.timeZone,
          initialize: data.initialize === true,
          revision: data.revision,
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!upstream.ok)
      return NextResponse.json(
        {error: 'Save failed'},
        {
          status: [400, 401, 409].includes(upstream.status)
            ? upstream.status
            : 503,
          headers,
        },
      );
    const body: unknown = await upstream.json();
    if (
      !isRecord(body) ||
      !isRoom(body.room) ||
      body.room.id !== id ||
      !validTimeZone(body.room.timeZone)
    )
      return NextResponse.json({error: 'Invalid room'}, {status: 502, headers});
    const room = {
      id: body.room.id,
      name: body.room.name,
      createdAt: body.room.createdAt,
      revision: body.room.revision,
      timeZone: body.room.timeZone,
    };
    const response = NextResponse.json({room}, {headers});
    rememberRoom(response, request, room, token);
    return response;
  } catch {
    return NextResponse.json({error: 'Save failed'}, {status: 503, headers});
  }
}
