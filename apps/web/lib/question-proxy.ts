import {NextResponse} from 'next/server';
import {roomIdPattern} from './rooms';
import {savedRooms, sameOrigin} from './recent-rooms';
import {isRecord, validCursor} from './voting-links';
import {
  isQuestion,
  isQuestionInput,
  isQuestionSummary,
  publicSummary,
  questionInput,
  validQuestionCursor,
} from './questions';

const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
// Expose short codes only, without database details
function failure(status: number, error = 'Request failed') {
  return NextResponse.json({error}, {status, headers});
}
// Forward admin question requests using only this room's session
export async function questionProxy(
  request: Request,
  room: string,
  id?: string,
  policy = false,
  lifecycle = false,
  reset = false,
) {
  if (!roomIdPattern.test(room) || (id && !roomIdPattern.test(id)))
    return failure(401);
  const token = savedRooms(request).find((entry) => entry.id === room)?.token;
  // Participant cookies never grant editor access
  if (!token) return failure(401);
  let body: Record<string, unknown> | undefined;
  const after = new URL(request.url).searchParams.get('after') ?? '0';
  if (!validQuestionCursor(after)) return failure(400);
  if (request.method !== 'GET') {
    // All cookie writes require a same-site JSON request
    if (!sameOrigin(request)) return failure(403);
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return failure(415);
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 4 * 1024 * 1024)
        return failure(413);
      const data: unknown = JSON.parse(text);
      if (!isRecord(data)) return failure(400);
      if ((id || policy) && !validCursor(data.revision)) return failure(400);
      if (reset) {
        body = {revision: data.revision};
      } else if (lifecycle) {
        if (
          !['open', 'close', 'settings', 'cancel_start'].includes(
            String(data.action),
          )
        )
          return failure(400);
        body = {
          action: data.action,
          revision: data.revision,
          ...(data.closesAt !== undefined ? {closesAt: data.closesAt} : {}),
          ...(data.startMode !== undefined
            ? {
                startMode: data.startMode,
                startsAt: data.startsAt,
                startAfterSeconds: data.startAfterSeconds,
              }
            : {}),
          shareResults: data.shareResults,
          allowSkip: data.allowSkip,
          publication: data.publication,
        };
      } else if (policy) {
        if (typeof data.lockAfterOpen !== 'boolean') return failure(400);
        body = {lockAfterOpen: data.lockAfterOpen, revision: data.revision};
      } else if (request.method === 'DELETE') {
        body = {revision: data.revision};
      } else {
        if (!isQuestionInput(data)) return failure(400);
        body = {
          ...questionInput(data),
          ...(data.startMode !== undefined
            ? {
                startMode: data.startMode,
                startsAt: data.startsAt,
                startAfterSeconds: data.startAfterSeconds,
              }
            : {}),
          ...(data.state !== undefined ? {state: data.state} : {}),
          ...(data.deadlineMode !== undefined
            ? {
                deadlineMode: data.deadlineMode,
                closesAt: data.closesAt,
                closeAfterSeconds: data.closeAfterSeconds,
              }
            : {}),
          ...(id ? {revision: data.revision} : {}),
        };
      }
    } catch {
      return failure(400);
    }
  }
  try {
    const path = `/api/rooms/${room}/${policy ? 'question-policy' : `questions${id ? `/${id}${reset ? '/reset' : lifecycle ? '/lifecycle' : ''}` : `?${new URLSearchParams({after})}`}`}`;
    const upstream = await fetch(
      new URL(path, process.env.API_ORIGIN ?? 'http://api:8080'),
      {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok) {
      const status = [400, 401, 404, 409, 413].includes(upstream.status)
        ? upstream.status
        : 503;
      const data = await upstream.json().catch(() => null);
      const error =
        isRecord(data) &&
        [
          'type_fixed',
          'capacity',
          'conflict',
          'locked',
          'asset',
          'deadline',
          'ready',
          'state',
          'used_options',
          'ballots',
          'electorate',
          'electorate_locked',
          'complete',
        ].includes(String(data.error))
          ? String(data.error)
          : 'Request failed';
      return failure(status, error);
    }
    const data: unknown = await upstream.json();
    if (!isRecord(data)) return failure(502);
    if (policy) {
      if (
        !isRecord(data.policy) ||
        typeof data.policy.lockAfterOpen !== 'boolean' ||
        !validCursor(data.policy.revision)
      )
        return failure(502);
      return NextResponse.json(
        {
          policy: {
            lockAfterOpen: data.policy.lockAfterOpen,
            revision: data.policy.revision,
          },
        },
        {headers},
      );
    }
    if (request.method === 'DELETE') {
      if (data.deletedId !== id) return failure(502);
      return NextResponse.json({deletedId: id}, {headers});
    }
    if (id || request.method === 'POST') {
      if (
        !isQuestion(data.question) ||
        data.question.roomId !== room ||
        (id && data.question.id !== id)
      )
        return failure(502);
      return NextResponse.json(
        {
          question: {
            ...publicSummary(data.question),
            ...questionInput(data.question),
          },
        },
        {status: upstream.status, headers},
      );
    }
    if (
      !Array.isArray(data.questions) ||
      !data.questions.every(
        (item) => isQuestionSummary(item) && item.roomId === room,
      ) ||
      (data.nextCursor !== null &&
        (!validQuestionCursor(data.nextCursor) || data.nextCursor === '0'))
    )
      return failure(502);
    return NextResponse.json(
      {
        questions: data.questions.map(publicSummary),
        nextCursor: data.nextCursor,
      },
      {headers},
    );
  } catch {
    return failure(503);
  }
}
