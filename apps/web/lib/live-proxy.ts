import {savedRooms} from './recent-rooms';
import {participantToken} from './ballot-proxy';
import {roomIdPattern} from './rooms';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Forward a stream with cancellation and no fixed request timeout
export async function liveProxy(request: Request, id: string, admin: boolean) {
  const token = admin
    ? savedRooms(request).find((room) => room.id === id)?.token
    : participantToken(request, id);
  if (!roomIdPattern.test(id) || !token)
    return Response.json({error: 'Access required'}, {status: 401, headers});
  try {
    const upstream = await fetch(
      new URL(
        `/api/${admin ? 'rooms' : 'vote'}/${id}/events`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        cache: 'no-store',
        redirect: 'error',
        signal: request.signal,
      },
    );
    if (
      !upstream.ok ||
      !upstream.body ||
      !upstream.headers.get('content-type')?.startsWith('text/event-stream')
    )
      return Response.json(
        {error: 'Live updates unavailable'},
        {status: upstream.status === 401 ? 401 : 503, headers},
      );
    return new Response(upstream.body, {
      headers: {
        ...headers,
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch {
    return Response.json(
      {error: 'Live updates unavailable'},
      {status: 503, headers},
    );
  }
}
