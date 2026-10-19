import {expect, it, vi} from 'vitest';
import {liveProxy} from '../lib/live-proxy';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
it('forwards a private cancellable stream without a short timeout', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response('event: ready\ndata: {}\n\n', {
      headers: {'Content-Type': 'text/event-stream'},
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const request = new Request(`http://localhost/api/vote/${id}/events`, {
    headers: {Cookie: `vm_vote_${id}=${token}`},
  });
  const response = await liveProxy(request, id, false);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(fetcher.mock.calls[0][1].signal).toBe(request.signal);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
    `Bearer ${token}`,
  );
  expect(await response.text()).toContain('event: ready');
});
it('does not borrow a different link cookie', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const response = await liveProxy(
    new Request(`http://localhost/api/vote/${id}/events`, {
      headers: {Cookie: `vm_vote_other=${token}`},
    }),
    id,
    false,
  );
  expect(response.status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
});
