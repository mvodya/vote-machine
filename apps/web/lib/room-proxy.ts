import {NextResponse} from 'next/server';
import {isRoom, roomIdPattern, secretPattern, validName} from './rooms';
import {
  savedRooms,
  rememberRoom,
  sameOrigin,
  roomCookieName,
  forgetRoom,
} from './recent-rooms';

const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
type Action = 'create' | 'exchange' | 'read' | 'rename' | 'link' | 'delete';

// Return a safe error without private details
function failure(status: number) {
  return NextResponse.json(
    {error: status === 401 ? 'Admin access required' : 'Request failed'},
    {status, headers},
  );
}

export const sessionCookie = roomCookieName;

// Check browser requests before sending them to the API
export async function roomProxy(request: Request, action: Action, id?: string) {
  // Existing room actions need a valid ID
  if (action !== 'create' && !roomIdPattern.test(id ?? '')) return failure(401);
  const changing = action !== 'read' && action !== 'link';
  // Writes need both an origin check and valid JSON
  if (changing) {
    // Reject writes from another site
    if (!sameOrigin(request)) return failure(403);
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return failure(415);
  }
  try {
    let payload: Record<string, string> | undefined;
    // Read the needed fields for a write
    if (changing) {
      const text = await request.text();
      // Reject bodies larger than 4 KB
      if (new TextEncoder().encode(text).length > 4096) return failure(413);
      const json: unknown = JSON.parse(text);
      // Read fields only from a JSON object
      if (typeof json !== 'object' || json === null || Array.isArray(json))
        return failure(400);
      const body = json as Record<string, unknown>;
      // Link entry uses an admin key, not a room name
      if (action === 'delete') {
        if (
          body.confirmation !== id ||
          typeof body.revision !== 'string' ||
          !/^(0|[1-9][0-9]{0,18})$/.test(body.revision)
        )
          return failure(400);
        payload = {confirmation: id!, revision: body.revision};
      } else if (action === 'exchange') {
        if (typeof body.token !== 'string' || !secretPattern.test(body.token))
          return failure(401);
        payload = {token: body.token};
      } else {
        const name = Object.hasOwn(body, 'name')
          ? body.name
          : action === 'create'
            ? ''
            : undefined;
        if (!validName(name)) return failure(400);
        payload = {name};
      }
    }
    let sessionToken: string | undefined;
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Use only the session saved for this room
    if (
      action === 'read' ||
      action === 'rename' ||
      action === 'link' ||
      action === 'delete'
    ) {
      const token =
        savedRooms(request).find((item) => item.id === id)?.token ?? '';
      if (!secretPattern.test(token)) return failure(401);
      sessionToken = token;
      upstreamHeaders.Authorization = `Bearer ${token}`;
    }
    const path =
      action === 'create'
        ? '/api/rooms'
        : `/api/rooms/${id}${action === 'exchange' ? '/session' : action === 'link' ? '/admin-link' : ''}`;
    // Send only needed data and headers to the API
    const upstream = await fetch(
      new URL(path, process.env.API_ORIGIN ?? 'http://api:8080'),
      {
        method:
          action === 'read' || action === 'link'
            ? 'GET'
            : action === 'delete'
              ? 'DELETE'
              : action === 'rename'
                ? 'PATCH'
                : 'POST',
        headers: upstreamHeaders,
        body: payload ? JSON.stringify(payload) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    // Hide internal errors from the browser
    if (!upstream.ok)
      return failure(
        [400, 401, 403, 409, 413].includes(upstream.status)
          ? upstream.status
          : 503,
      );
    const body: unknown = await upstream.json();
    // Forget this browser entry only after the database confirms deletion
    if (action === 'delete') {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('deletedId' in body) ||
        body.deletedId !== id
      )
        return failure(502);
      const response = NextResponse.json({deletedId: id}, {headers});
      forgetRoom(response, request, id!);
      return response;
    }
    // Settings may show the key after the session check
    if (action === 'link') {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('adminToken' in body) ||
        typeof body.adminToken !== 'string' ||
        !secretPattern.test(body.adminToken)
      )
        return failure(502);
      return NextResponse.json({adminToken: body.adminToken}, {headers});
    }
    // Reject bad data and replies for another room
    if (
      typeof body !== 'object' ||
      body === null ||
      !('room' in body) ||
      !isRoom(body.room) ||
      (id && body.room.id !== id)
    )
      return failure(502);
    // Copy only public room fields
    const result: Record<string, unknown> = {
      room: {
        id: body.room.id,
        name: body.room.name,
        createdAt: body.room.createdAt,
        revision: body.room.revision,
        ...(body.room.timeZone !== undefined
          ? {timeZone: body.room.timeZone}
          : {}),
      },
    };
    // A new room returns its first admin link
    if (action === 'create') {
      if (
        !('adminToken' in body) ||
        typeof body.adminToken !== 'string' ||
        !secretPattern.test(body.adminToken)
      )
        return failure(502);
      result.adminToken = body.adminToken;
    }
    const response = NextResponse.json(result, {
      status: action === 'create' ? 201 : 200,
      headers,
    });
    // Keep the new session key in a private cookie
    if (action === 'exchange') {
      if (
        !('sessionToken' in body) ||
        typeof body.sessionToken !== 'string' ||
        !secretPattern.test(body.sessionToken)
      )
        return failure(502);
      sessionToken = body.sessionToken;
    }
    // Refresh the cached name only after this room is used
    if (sessionToken) rememberRoom(response, request, body.room, sessionToken);
    return response;
  } catch (error) {
    return failure(error instanceof SyntaxError ? 400 : 503);
  }
}
