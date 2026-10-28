import {savedRooms, sameOrigin} from './recent-rooms';
import {participantToken} from './ballot-proxy';
import {roomIdPattern} from './rooms';
import {isAccent} from './experience';
const headers = {'Cache-Control': 'private, no-store'};
// Keep room preferences behind the same scoped access check
export async function experienceProxy(
  request: Request,
  id: string,
  admin: boolean,
) {
  const token = admin
    ? savedRooms(request).find((room) => room.id === id)?.token
    : participantToken(request, id);
  if (!roomIdPattern.test(id) || !token)
    return Response.json({error: 'Access required'}, {status: 401, headers});
  try {
    const write = request.method === 'PATCH';
    if (write && (!admin || !sameOrigin(request)))
      return Response.json({error: 'Origin denied'}, {status: 403, headers});
    const query = new URL(request.url).searchParams;
    const after = query.get('after');
    if (after !== null && !/^\d{1,19}$/.test(after))
      return Response.json({error: 'Invalid cursor'}, {status: 400, headers});
    let body;
    if (write) {
      if (
        request.headers.get('content-type')?.split(';')[0] !==
        'application/json'
      )
        return Response.json({error: 'JSON required'}, {status: 415, headers});
      const text = await request.text();
      if (text.length > 256)
        return Response.json({error: 'Too large'}, {status: 413, headers});
      const data = JSON.parse(text);
      if (
        (!isAccent(data?.accent) &&
          typeof data?.showAllResults !== 'boolean') ||
        (data?.accent !== undefined && !isAccent(data.accent)) ||
        (data?.showAllResults !== undefined &&
          typeof data.showAllResults !== 'boolean')
      )
        return Response.json({error: 'Invalid accent'}, {status: 400, headers});
      body = JSON.stringify({
        ...(data.accent !== undefined ? {accent: data.accent} : {}),
        ...(data.showAllResults !== undefined
          ? {showAllResults: data.showAllResults}
          : {}),
      });
    }
    const response = await fetch(
      new URL(
        `/api/${admin ? 'rooms' : 'vote'}/${id}/experience${after === null ? '' : `?after=${after}`}`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: write ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      return Response.json(
        {error: 'Request failed'},
        {
          status: [400, 401, 403].includes(response.status)
            ? response.status
            : 503,
          headers,
        },
      );
    if (
      !isAccent(data.accent) ||
      typeof data.cursor !== 'string' ||
      !/^\d+$/.test(data.cursor) ||
      !Array.isArray(data.timers) ||
      data.timers.length > 182 ||
      !data.timers.every(
        (at: unknown) =>
          typeof at === 'string' && Number.isFinite(Date.parse(at)),
      ) ||
      !Array.isArray(data.events) ||
      data.events.length > 100 ||
      !data.events.every(
        (event: {id: unknown; kind: unknown}) =>
          event &&
          typeof event.id === 'string' &&
          /^\d+$/.test(event.id) &&
          ['open', 'close', ...(admin ? ['answer'] : [])].includes(
            String(event.kind),
          ),
      )
    )
      throw new Error();
    return Response.json(
      {
        accent: data.accent,
        showAllResults: data.showAllResults === true,
        cursor: data.cursor,
        timers: data.timers,
        events: data.events.map((event: {id: string; kind: string}) => ({
          id: event.id,
          kind: event.kind,
        })),
      },
      {headers},
    );
  } catch {
    return Response.json(
      {error: 'Request unavailable'},
      {status: 503, headers},
    );
  }
}
