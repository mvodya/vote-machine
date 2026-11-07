import {NextResponse} from 'next/server';
import {roomIdPattern, secretPattern} from './rooms';
import {votingCookie} from './link-proxy';
import {sameOrigin} from './recent-rooms';
import {isRecord, validCursor} from './voting-links';
import {isAnswer, publicAnswer} from './ballots';

const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Keep database errors and role details private
function failure(status: number, error = 'Request failed') {
  return NextResponse.json({error}, {status, headers});
}
// Read only this participant's cookie, never an admin room cookie
export function participantToken(request: Request, id: string) {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${votingCookie(id)}=`))
    ?.split('=')[1];
  return token && secretPattern.test(token) ? token : null;
}
// Retry identity and expected versions pass unchanged to PostgreSQL
export async function ballotProxy(
  request: Request,
  link: string,
  question: string,
) {
  if (!roomIdPattern.test(link) || !roomIdPattern.test(question))
    return failure(401);
  const token = participantToken(request, link);
  if (!token) return failure(401);
  let body;
  if (request.method === 'POST') {
    if (!sameOrigin(request)) return failure(403);
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return failure(415);
    try {
      const source = await request.text();
      if (source.length > 16384) return failure(413);
      const data: unknown = JSON.parse(source);
      if (
        !isRecord(data) ||
        typeof data.requestId !== 'string' ||
        !roomIdPattern.test(data.requestId) ||
        !validCursor(data.questionRevision) ||
        !validCursor(data.ballotRevision) ||
        !Array.isArray(data.choices) ||
        data.choices.length > 100 ||
        !data.choices.every(
          (id) => typeof id === 'string' && roomIdPattern.test(id),
        ) ||
        new Set(data.choices).size !== data.choices.length
      )
        return failure(400);
      body = {
        requestId: data.requestId,
        questionRevision: data.questionRevision,
        ballotRevision: data.ballotRevision,
        choices: data.choices,
        ...(typeof data.runId === 'string' && roomIdPattern.test(data.runId)
          ? {runId: data.runId}
          : {}),
      };
    } catch {
      return failure(400);
    }
  }
  try {
    const response = await fetch(
      new URL(
        `/api/vote/${link}/answers/${question}${request.method === 'GET' && roomIdPattern.test(new URL(request.url).searchParams.get('run') ?? '') ? `?run=${new URL(request.url).searchParams.get('run')}` : ''}`,
        process.env.API_ORIGIN ?? 'http://api:8080',
      ),
      {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      },
    );
    const data: unknown = await response.json();
    if (!response.ok)
      return failure(
        [400, 401, 404, 409].includes(response.status) ? response.status : 503,
        isRecord(data) &&
          [
            'full',
            'closed',
            'changed',
            'used',
            'answer_changed',
            'idempotency',
            'choices',
            'mode',
            'sequence',
          ].includes(String(data.error))
          ? String(data.error)
          : 'Request failed',
      );
    if (
      !isRecord(data) ||
      (data.answer !== null &&
        (!isAnswer(data.answer) || data.answer.questionId !== question))
    )
      return failure(502);
    return NextResponse.json(
      {answer: data.answer === null ? null : publicAnswer(data.answer)},
      {headers},
    );
  } catch {
    return failure(503);
  }
}
