import {savedRooms} from './recent-rooms';
import {roomIdPattern} from './rooms';
import {isRecord} from './voting-links';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Read online metadata for this admin page without returning session identities
export async function onlineProxy(request: Request, room: string) {
  const token = savedRooms(request).find((item) => item.id === room)?.token;
  if (!token || !roomIdPattern.test(room))
    return Response.json({error: 'Access required'}, {status: 401, headers});
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .filter(Boolean);
  if (ids.length > 50 || !ids.every((id) => roomIdPattern.test(id)))
    return Response.json({error: 'Invalid links'}, {status: 400, headers});
  try {
    const response = await fetch(
      new URL(
        `/api/rooms/${room}/presence`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ids}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok)
      return Response.json(
        {error: 'Online data unavailable'},
        {status: response.status === 401 ? 401 : 503, headers},
      );
    const data = await response.json();
    if (!Array.isArray(data.links)) throw new Error();
    const links = [];
    for (const value of data.links) {
      if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        !ids.includes(value.id) ||
        !Number.isSafeInteger(value.online) ||
        Number(value.online) < 0 ||
        !Array.isArray(value.questions)
      )
        throw new Error();
      const questions = [];
      for (const q of value.questions) {
        if (
          !isRecord(q) ||
          typeof q.id !== 'string' ||
          !roomIdPattern.test(q.id) ||
          typeof q.preview !== 'string'
        )
          throw new Error();
        questions.push({id: q.id, preview: q.preview});
      }
      links.push({id: value.id, online: value.online, questions});
    }
    return Response.json({links}, {headers});
  } catch {
    return Response.json(
      {error: 'Online data unavailable'},
      {status: 503, headers},
    );
  }
}
