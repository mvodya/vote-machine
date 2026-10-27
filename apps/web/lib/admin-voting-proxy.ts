import {NextResponse} from 'next/server';
import {savedRooms, sameOrigin} from './recent-rooms';
import {roomIdPattern} from './rooms';
import {isRecord, validCursor} from './voting-links';
import {isQuestion, publicSummary, questionInput} from './questions';
import {isAnswer, publicAnswer} from './ballots';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Keep room voting tools behind the selected admin session
export async function adminVotingProxy(
  request: Request,
  room: string,
  question?: string,
) {
  const token = savedRooms(request).find((item) => item.id === room)?.token;
  if (
    !token ||
    !roomIdPattern.test(room) ||
    (question && !roomIdPattern.test(question))
  )
    return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
  let body;
  if (request.method !== 'GET') {
    if (!sameOrigin(request))
      return NextResponse.json(
        {error: 'Origin denied'},
        {status: 403, headers},
      );
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return NextResponse.json(
        {error: 'JSON required'},
        {status: 415, headers},
      );
    try {
      const text = await request.text();
      if (text.length > 16384)
        return NextResponse.json({error: 'Too large'}, {status: 413, headers});
      const input: unknown = JSON.parse(text);
      if (!isRecord(input)) throw new Error();
      if (
        question &&
        (typeof input.requestId !== 'string' ||
          !roomIdPattern.test(input.requestId) ||
          !validCursor(input.questionRevision) ||
          !validCursor(input.ballotRevision) ||
          !Array.isArray(input.choices) ||
          input.choices.length > 100 ||
          !input.choices.every(
            (id) => typeof id === 'string' && roomIdPattern.test(id),
          ) ||
          new Set(input.choices).size !== input.choices.length ||
          (input.linkId !== undefined &&
            (typeof input.linkId !== 'string' ||
              !roomIdPattern.test(input.linkId))))
      )
        throw new Error();
      if (
        !question &&
        (typeof input.enabled !== 'boolean' || !validCursor(input.revision))
      )
        throw new Error();
      body = question
        ? {
            requestId: input.requestId,
            questionRevision: input.questionRevision,
            ballotRevision: input.ballotRevision,
            choices: input.choices,
            ...(input.linkId ? {linkId: input.linkId} : {}),
          }
        : {enabled: input.enabled, revision: input.revision};
    } catch {
      return NextResponse.json(
        {error: 'Invalid request'},
        {status: 400, headers},
      );
    }
  }
  const link = new URL(request.url).searchParams.get('linkId');
  if (link && !roomIdPattern.test(link))
    return NextResponse.json({error: 'Invalid link'}, {status: 400, headers});
  try {
    const response = await fetch(
      new URL(
        `/api/rooms/${room}/${question ? `questions/${question}/manual${link ? `?linkId=${link}` : ''}` : 'reuse-policy'}`,
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
      return NextResponse.json(
        {
          error:
            isRecord(data) &&
            [
              'used',
              'closed',
              'changed',
              'answer_changed',
              'conflict',
              'idempotency',
            ].includes(String(data.error))
              ? data.error
              : 'Request failed',
        },
        {
          status: [400, 401, 404, 409].includes(response.status)
            ? response.status
            : 503,
          headers,
        },
      );
    if (!isRecord(data)) throw new Error();
    if (!question) {
      if (
        !isRecord(data.policy) ||
        typeof data.policy.enabled !== 'boolean' ||
        !validCursor(data.policy.revision)
      )
        throw new Error();
      return NextResponse.json(
        {
          policy: {
            enabled: data.policy.enabled,
            revision: data.policy.revision,
          },
        },
        {headers},
      );
    }
    if (request.method === 'GET') {
      if (
        !isQuestion(data.question) ||
        data.question.id !== question ||
        data.question.roomId !== room ||
        typeof data.answered !== 'boolean' ||
        !validCursor(data.answerRevision)
      )
        throw new Error();
      return NextResponse.json(
        {
          question: {
            ...publicSummary(data.question),
            ...questionInput(data.question),
          },
          answered: data.answered,
          answerRevision: data.answerRevision,
        },
        {headers},
      );
    }
    if (!isAnswer(data.answer) || data.answer.questionId !== question)
      throw new Error();
    return NextResponse.json({answer: publicAnswer(data.answer)}, {headers});
  } catch {
    return NextResponse.json(
      {error: 'Voting unavailable'},
      {status: 503, headers},
    );
  }
}
