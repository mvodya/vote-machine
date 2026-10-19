import {NextResponse} from 'next/server';
import {roomIdPattern} from './rooms';
import {savedRooms} from './recent-rooms';
import {participantToken} from './ballot-proxy';
import {validCursor, isRecord} from './voting-links';
import {publicResult, resultPage, resultCsv} from './results';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Apply role filtering before JSON or CSV leaves the web server
export async function resultsProxy(
  request: Request,
  id: string,
  admin: boolean,
) {
  const token = admin
    ? savedRooms(request).find((room) => room.id === id)?.token
    : participantToken(request, id);
  if (!roomIdPattern.test(id) || !token)
    return NextResponse.json(
      {error: 'Access required'},
      {status: 401, headers},
    );
  const input = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ['question', 'peopleAfter', 'run']) {
    const value = input.get(key);
    if (value !== null) {
      if (!roomIdPattern.test(value))
        return NextResponse.json(
          {error: 'Invalid request'},
          {status: 400, headers},
        );
      query.set(key, value);
    }
  }
  if (input.has('after')) {
    if (!validCursor(input.get('after')))
      return NextResponse.json({error: 'Invalid page'}, {status: 400, headers});
    query.set('after', input.get('after')!);
  }
  const projector = admin && input.get('view') === 'projector';
  if (projector) query.set('view', 'projector');
  try {
    const response = await fetch(
      new URL(
        `/api/${admin ? 'rooms' : 'vote'}/${id}/results?${query}`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        headers: {Authorization: `Bearer ${token}`},
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok)
      return NextResponse.json(
        {error: 'Results unavailable'},
        {
          status: [400, 401, 404].includes(response.status)
            ? response.status
            : 503,
          headers,
        },
      );
    const data: unknown = await response.json();
    const result =
      isRecord(data) && query.has('question')
        ? publicResult(data.result, admin, projector)
        : null;
    if (query.has('question')) {
      if (!result || result.id !== query.get('question')) throw new Error();
      if (input.get('format') === 'csv') {
        const csv = resultCsv(result);
        if (csv === null)
          return NextResponse.json(
            {error: 'Results unavailable'},
            {status: 403, headers},
          );
        return new Response(csv, {
          headers: {
            ...headers,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="results.csv"',
          },
        });
      }
      return NextResponse.json({result}, {headers});
    }
    const page = resultPage(data);
    if (!page) throw new Error();
    return NextResponse.json(page, {headers});
  } catch {
    return NextResponse.json(
      {error: 'Results unavailable'},
      {status: 503, headers},
    );
  }
}
