import {describe, expect, it, vi} from 'vitest';
import {
  emptyQuestion,
  isQuestionInput,
  isQuestion,
  validQuestionCursor,
} from '../lib/questions';
import {questionProxy} from '../lib/question-proxy';
import {roomCookieValue} from '../lib/recent-rooms';

const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494e';
const token = 'a'.repeat(64);
const question = {
  ...emptyQuestion(),
  id,
  roomId: room,
  preview: '',
  ordinal: '1',
  revision: '1',
  createdAt: '2026-10-25T00:00:00.123456Z',
  state: 'draft',
  editLocked: null,
  choiceCount: 2,
  choices: [
    {id: 'b96c3a49-0198-4545-8dce-44b70c86494e', content: ''},
    {id: 'c96c3a49-0198-4545-8dce-44b70c86494e', content: ''},
  ],
};
// Use one saved admin session for request boundary tests
function request(
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://vote.test/api/rooms/${room}/questions`, {
    method,
    headers: {
      Cookie: `vm_room_${room}=${roomCookieValue({id: room, name: 'Room', token, usedAt: 1})}`,
      Origin: 'https://vote.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

describe('question documents', () => {
  it('accepts empty drafts and whole Unicode characters at the limits', () => {
    expect(
      isQuestionInput({
        ...emptyQuestion(),
        content: '🌍'.repeat(20000),
        choices: [{content: '🌍'.repeat(5000)}],
      }),
    ).toBe(true);
    expect(isQuestionInput({...emptyQuestion(), choices: []})).toBe(true);
    expect(isQuestion(question)).toBe(true);
  });
  it.each([
    {content: 'x'.repeat(20001)},
    {choices: [{content: 'x'.repeat(5001)}]},
    {content: '\0'},
    {choices: Array(101).fill({content: ''})},
    {minChoices: 0},
    {choiceMode: 'multiple', minChoices: -1},
    {choiceMode: 'multiple', minChoices: 0, maxChoices: 0},
    {maxChoices: 3},
    {maxChoices: 1.5},
    {choiceMode: 'multiple', minChoices: 2, maxChoices: 1},
    {choiceMode: 'single', maxChoices: 2},
    {anonymous: null},
    {
      choices: [
        {id, content: 'A'},
        {id, content: 'B'},
      ],
    },
  ])('rejects invalid source, limits or option IDs', (extra) =>
    expect(isQuestionInput({...emptyQuestion(), ...extra})).toBe(false),
  );
  it('accepts zero as the multiple-choice minimum', () => {
    expect(
      isQuestionInput({
        ...emptyQuestion(),
        choiceMode: 'multiple',
        minChoices: 0,
      }),
    ).toBe(true);
  });
  it('keeps the full cursor precise and usable without a saved boundary row', () => {
    expect(
      validQuestionCursor('2026-10-25T00:00:00.123456Z~9223372036854775807'),
    ).toBe(true);
    for (const value of [
      'bad',
      '1',
      '2026-10-25T00:00:00.123456Z~0',
      '2026-10-25T00:00:00.123456Z~9223372036854775808',
    ])
      expect(validQuestionCursor(value)).toBe(false);
  });
});
describe('question browser boundary', () => {
  it('requires admin access and same-site JSON writes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(
      (
        await questionProxy(
          request('GET', undefined, {Cookie: `vm_vote_${id}=${token}`}),
          room,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await questionProxy(
          request('POST', emptyQuestion(), {Origin: 'https://evil.test'}),
          room,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await questionProxy(
          request('POST', emptyQuestion(), {'Content-Type': 'text/plain'}),
          room,
        )
      ).status,
    ).toBe(415);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid documents and missing versions without calling the API', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(
      (
        await questionProxy(
          request('POST', {...emptyQuestion(), maxChoices: 3}),
          room,
        )
      ).status,
    ).toBe(400);
    expect(
      (await questionProxy(request('PATCH', emptyQuestion()), room, id)).status,
    ).toBe(400);
    expect((await questionProxy(request('DELETE', {}), room, id)).status).toBe(
      400,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('strips extra fields on both sides of an editor request', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            {question: {...question, adminToken: token}},
            {status: 201},
          ),
        ),
    );
    const response = await questionProxy(
      request('POST', {
        ...emptyQuestion(),
        state: 'open',
        roomId: id,
        adminToken: token,
      }),
      room,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({question});
    const forwarded = JSON.parse(
      vi.mocked(fetch).mock.calls[0][1]!.body as string,
    );
    expect(forwarded).not.toHaveProperty('adminToken');
    expect(forwarded.state).toBe('open');
    expect(forwarded).not.toHaveProperty('roomId');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects foreign room data and keeps list responses small', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({question: {...question, roomId: id}}),
        ),
    );
    expect((await questionProxy(request(), room, id)).status).toBe(502);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          questions: [{...question, adminToken: token}],
          nextCursor: null,
        }),
      ),
    );
    const response = await questionProxy(request(), room);
    const body = await response.json();
    expect(body.questions[0]).not.toHaveProperty('choices');
    expect(body.questions[0]).not.toHaveProperty('content');
    expect(body.questions[0]).not.toHaveProperty('adminToken');
  });
  it('preserves conflict codes but hides internal errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({error: 'conflict', sql: token}, {status: 409}),
        ),
    );
    const conflict = await questionProxy(request('PATCH', question), room, id);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({error: 'conflict'});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({error: token}, {status: 500})),
    );
    const failure = await questionProxy(request(), room);
    expect(failure.status).toBe(503);
    expect(JSON.stringify(await failure.json())).not.toContain(token);
  });
  it('checks room rule input and returns only its value and version', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(
      (
        await questionProxy(
          request('PATCH', {lockAfterOpen: 'yes', revision: '0'}),
          room,
          undefined,
          true,
        )
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          policy: {lockAfterOpen: false, revision: '2', private: token},
        }),
      ),
    );
    const response = await questionProxy(
      request('PATCH', {lockAfterOpen: false, revision: '1'}),
      room,
      undefined,
      true,
    );
    expect(await response.json()).toEqual({
      policy: {lockAfterOpen: false, revision: '2'},
    });
  });
});
