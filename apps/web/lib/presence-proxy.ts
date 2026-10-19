import {participantToken} from './ballot-proxy';
import {roomIdPattern} from './rooms';
import {sameOrigin} from './recent-rooms';
import {isRecord} from './voting-links';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Only the current participant may update its short view lease
export async function presenceProxy(request: Request, id: string) {
  const token = participantToken(request, id);
  if (!roomIdPattern.test(id) || !token)
    return Response.json({error: 'Access required'}, {status: 401, headers});
  if (!sameOrigin(request))
    return Response.json({error: 'Origin denied'}, {status: 403, headers});
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return Response.json({error: 'JSON required'}, {status: 415, headers});
  try {
    const text = await request.text();
    if (text.length > 4096)
      return Response.json({error: 'Too large'}, {status: 413, headers});
    const data: unknown = JSON.parse(text);
    if (
      !isRecord(data) ||
      typeof data.tabId !== 'string' ||
      !roomIdPattern.test(data.tabId) ||
      !Number.isSafeInteger(data.sequence) ||
      Number(data.sequence) < 1 ||
      (data.questionId !== null &&
        (typeof data.questionId !== 'string' ||
          !roomIdPattern.test(data.questionId))) ||
      (data.runId !== undefined &&
        (typeof data.runId !== 'string' || !roomIdPattern.test(data.runId)))
    )
      return Response.json({error: 'Invalid view'}, {status: 400, headers});
    const response = await fetch(
      new URL(
        `/api/vote/${id}/presence`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tabId: data.tabId,
          sequence: data.sequence,
          questionId: data.questionId,
          ...(data.runId ? {runId: data.runId} : {}),
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    return Response.json(
      response.ok ? {ok: true} : {error: 'View unavailable'},
      {
        status: response.ok
          ? 200
          : [400, 401, 404].includes(response.status)
            ? response.status
            : 503,
        headers,
      },
    );
  } catch (error) {
    return Response.json(
      {error: 'View unavailable'},
      {status: error instanceof SyntaxError ? 400 : 503, headers},
    );
  }
}
