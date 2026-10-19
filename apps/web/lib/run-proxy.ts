import {NextResponse} from 'next/server';
import {participantToken} from './ballot-proxy';
import {roomIdPattern} from './rooms';
import {sameOrigin} from './recent-rooms';
import {isRecord} from './voting-links';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Start an additional run only after an explicit allowed action
export async function runProxy(request: Request, link: string) {
  const token = participantToken(request, link);
  if (!roomIdPattern.test(link) || !token)
    return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
  if (!sameOrigin(request))
    return NextResponse.json({error: 'Origin denied'}, {status: 403, headers});
  try {
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw new Error();
    const text = await request.text();
    if (text.length > 4096) throw new Error();
    const body: unknown = JSON.parse(text);
    if (
      !isRecord(body) ||
      typeof body.requestId !== 'string' ||
      !roomIdPattern.test(body.requestId)
    )
      throw new Error();
    const response = await fetch(
      new URL(
        `/api/vote/${link}/runs`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({requestId: body.requestId}),
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      return NextResponse.json(
        {error: 'Run unavailable'},
        {
          status: [400, 401, 404, 409].includes(response.status)
            ? response.status
            : 503,
          headers,
        },
      );
    if (
      !isRecord(data) ||
      !isRecord(data.run) ||
      typeof data.run.id !== 'string' ||
      !roomIdPattern.test(data.run.id) ||
      typeof data.run.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(data.run.createdAt))
    )
      throw new Error();
    return NextResponse.json(
      {run: {id: data.run.id, createdAt: data.run.createdAt}},
      {headers},
    );
  } catch {
    return NextResponse.json(
      {error: 'Run unavailable'},
      {status: 400, headers},
    );
  }
}
