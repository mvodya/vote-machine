import {describe, expect, it, vi} from 'vitest';
import {roomProxy, sessionCookie} from '../lib/room-proxy';
import {roomCookieValue, savedRooms} from '../lib/recent-rooms';

const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
const room = {
  id,
  name: 'Room',
  createdAt: '2026-10-25T00:00:00Z',
  revision: '0',
};

const cookieValue = roomCookieValue({id, name: room.name, token, usedAt: 1});

// Build a browser request with a test origin
function request(
  method = 'POST',
  body: unknown = {name: ''},
  extra: Record<string, string> = {},
) {
  return new Request(`https://vote.test/api/rooms/${id}`, {
    method,
    headers: {
      Origin: 'https://vote.test',
      'Content-Type': 'application/json',
      ...extra,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

describe('Room browser boundary', () => {
  it.each(['https://evil.test', 'http://vote.test', 'null', ''])(
    'rejects a foreign or missing origin: %s',
    async (origin) => {
      const upstream = vi.fn();
      vi.stubGlobal('fetch', upstream);
      expect(
        (await roomProxy(request('POST', {}, {Origin: origin}), 'create'))
          .status,
      ).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('rejects cross-site and non-JSON writes before contacting the API', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect(
      (
        await roomProxy(
          request('POST', {}, {'Sec-Fetch-Site': 'cross-site'}),
          'create',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await roomProxy(
          request('POST', {}, {'Content-Type': 'text/plain'}),
          'create',
        )
      ).status,
    ).toBe(415);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {name: null},
    {name: 12},
    {name: 'x'.repeat(201)},
    {name: '\0'},
  ])('rejects invalid names and bodies', async (body) => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await roomProxy(request('POST', body), 'create')).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('only exposes the initial link key on creation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          room: {...room, secret: 'hidden'},
          adminToken: token,
          internal: 'hidden',
        }),
      ),
    );
    const response = await roomProxy(request(), 'create');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({room, adminToken: token});
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('exchanges a key for a secure HttpOnly room cookie and hides the session secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({room, sessionToken: token, internal: 'hidden'}),
        ),
    );
    const response = await roomProxy(request('POST', {token}), 'exchange', id);
    expect(await response.json()).toEqual({room});
    const cookie = response.headers.get('set-cookie');
    expect(
      savedRooms(
        new Request('https://vote.test', {headers: {cookie: cookie!}}),
      )[0]?.token,
    ).toBe(token);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=strict');
    expect(cookie).not.toContain('Max-Age=');
    expect(cookie).toContain('9999');
  });

  it('uses only the matching room cookie, ignoring browser Authorization', async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({room}));
    vi.stubGlobal('fetch', upstream);
    const response = await roomProxy(
      request('GET', undefined, {
        Cookie: `other=private; ${sessionCookie(id)}=${cookieValue}`,
        Authorization: 'Bearer untrusted',
      }),
      'read',
      id,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(sessionCookie(id));
    expect(response.headers.get('set-cookie')).toContain('9999');
    expect(upstream.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });
    expect(upstream.mock.calls[0][1].redirect).toBe('error');
    expect(upstream.mock.calls[0][1].headers.Cookie).toBeUndefined();
  });

  it('does not treat a different room cookie or bearer header as access', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(
      (
        await roomProxy(
          request('GET', undefined, {
            Cookie: `vm_admin_other=${token}`,
            Authorization: `Bearer ${token}`,
          }),
          'read',
          id,
        )
      ).status,
    ).toBe(401);
    expect((await roomProxy(request(), 'exchange', '../other')).status).toBe(
      401,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hides upstream failures and wrong room responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({secret: token}, {status: 500}))
        .mockResolvedValueOnce(
          Response.json({
            room: {...room, id: 'b96c3a49-0198-4545-8dce-44b70c86494d'},
          }),
        ),
    );
    const failed = await roomProxy(request(), 'create');
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain(token);
    expect(
      (
        await roomProxy(
          request('GET', undefined, {
            Cookie: `${sessionCookie(id)}=${cookieValue}`,
          }),
          'read',
          id,
        )
      ).status,
    ).toBe(502);
  });
});
