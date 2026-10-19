import {NextResponse} from 'next/server';
import {roomIdPattern} from './rooms';
import {validQuestionCursor} from './questions';
import {participantToken} from './ballot-proxy';
import {isJourney, publicJourney} from './journey';

const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Read a personal snapshot using only its scoped participant cookie
export async function journeyProxy(request: Request, id: string) {
  if (!roomIdPattern.test(id))
    return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
  const token = participantToken(request, id);
  if (!token)
    return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
  const input = new URL(request.url).searchParams;
  const query = new URLSearchParams({after: input.get('after') ?? '0'});
  if (!validQuestionCursor(query.get('after')))
    return NextResponse.json({error: 'Invalid page'}, {status: 400, headers});
  for (const key of ['selected', 'skip', 'run']) {
    const value = input.get(key);
    if (value !== null) {
      if (!roomIdPattern.test(value))
        return NextResponse.json(
          {error: 'Invalid question'},
          {status: 400, headers},
        );
      query.set(key, value);
    }
  }
  try {
    const response = await fetch(
      new URL(
        `/api/vote/${id}/questions?${query}`,
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
        {error: 'Snapshot unavailable'},
        {
          status: [400, 401, 404, 409].includes(response.status)
            ? response.status
            : 503,
          headers,
        },
      );
    const data: unknown = await response.json();
    if (!isJourney(data))
      return NextResponse.json(
        {error: 'Invalid snapshot'},
        {status: 502, headers},
      );
    return NextResponse.json(publicJourney(data), {headers});
  } catch {
    return NextResponse.json(
      {error: 'Snapshot unavailable'},
      {status: 503, headers},
    );
  }
}
