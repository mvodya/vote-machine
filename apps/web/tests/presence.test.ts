import {expect, it, vi} from 'vitest';
import {presenceProxy} from '../lib/presence-proxy';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
// Use a scoped cookie and browser-like origin for presence writes
function request(
  body: string,
  origin = 'http://localhost',
  cookie = `vm_vote_${id}=${token}`,
) {
  return new Request(`http://localhost/api/vote/${id}/presence`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body,
  });
}
it('rejects wrong cookies, foreign origins and malformed JSON before contacting the API', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(
    (
      await presenceProxy(
        request('{}', 'http://localhost', 'vm_vote_other=' + token),
        id,
      )
    ).status,
  ).toBe(401);
  expect(
    (await presenceProxy(request('{}', 'http://foreign.example'), id)).status,
  ).toBe(403);
  expect((await presenceProxy(request('{'), id)).status).toBe(400);
  expect(
    (
      await presenceProxy(
        request(JSON.stringify({tabId: id, sequence: -1, questionId: null})),
        id,
      )
    ).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('forwards view order and returns no internal session or respondent data', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ok: true, sessionId: 'private'}));
  vi.stubGlobal('fetch', fetcher);
  const response = await presenceProxy(
    request(
      JSON.stringify({
        tabId: id,
        sequence: 2,
        questionId: null,
        secret: 'discard',
        active: true,
      }),
    ),
    id,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok: true});
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    tabId: id,
    sequence: 2,
    questionId: null,
    active: true,
  });
  expect(response.headers.get('cache-control')).toContain('no-store');
});
