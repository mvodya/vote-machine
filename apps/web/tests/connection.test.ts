import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {GET} from '../app/api/connection/route';

it('diagnostics exposes safe process labels and a separate session tag', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const token = 'a'.repeat(64);
  const cookie = Buffer.from(
    JSON.stringify({id, name: 'Room', token, usedAt: 1}),
  ).toString('base64url');
  const body = {
    apiId: 'b'.repeat(12),
    commit: 'c'.repeat(40),
    serverTime: Date.now(),
    secret: token,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
  const response = await GET(
    new Request(`https://vote.test/api/connection?scope=rooms&id=${id}`, {
      headers: {Cookie: `vm_room_${id}=${cookie}`},
    }),
  );
  const data = await response.json();
  expect(data.clientId).toMatch(/^[a-f0-9]{16}$/);
  expect(data.clientId).not.toBe(
    createHash('sha256').update(token).digest('hex').slice(0, 16),
  );
  expect(JSON.stringify(data)).not.toContain(token);
  expect(data).not.toHaveProperty('secret');
  expect(response.headers.get('cache-control')).toContain('no-store');
});

it('diagnostics hides untrusted process data and returns no unrelated session tag', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        apiId: '/private/host',
        commit: 'secret',
        serverTime: Date.now(),
      }),
    ),
  );
  const response = await GET(new Request('https://vote.test/api/connection'));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('/private/host');
});
