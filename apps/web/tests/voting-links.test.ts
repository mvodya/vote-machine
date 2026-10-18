import {describe, expect, it, vi} from 'vitest';
import {
  linksCsv,
  linksText,
  validCursor,
  type ExportLink,
} from '../lib/voting-links';
import {
  adminLinkProxy,
  participantProxy,
  votingCookie,
} from '../lib/link-proxy';
import {roomCookieValue} from '../lib/recent-rooms';

const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const id = 'a96c3a49-0198-4545-8dce-44b70c86494e';
const token = 'a'.repeat(64);
const link: ExportLink = {
  id,
  name: 'Name',
  mode: 'personal',
  ordinal: '1',
  revision: '0',
  revoked: false,
  token,
};
const participant = {
  roomId: room,
  roomName: 'Room',
  linkId: id,
  name: 'Name',
  mode: 'personal',
};
const adminCookie = `vm_room_${room}=${roomCookieValue({id: room, name: 'Room', token, usedAt: 1})}`;
// Build a private request without involving the browser cookie store
function request(
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://vote.test/api/rooms/${room}/links`, {
    method,
    headers: {
      Cookie: adminCookie,
      Origin: 'https://vote.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

describe('link exports', () => {
  it('escapes CSV fields, blocks formulas and leaves revoked URLs empty', () => {
    const csv = linksCsv(
      [
        {...link, name: ' =SUM(1,2)'},
        {...link, name: 'A "quote"\nNew line', revoked: true},
      ],
      'https://vote.test',
    );
    expect(csv.startsWith('\uFEFF"Имя","Режим","Статус","Ссылка"\r\n')).toBe(
      true,
    );
    expect(csv).toContain('"\' =SUM(1,2)"');
    expect(csv).toContain(
      '"A ""quote""\nNew line","Персональная","Отозвана",""',
    );
    expect(csv.match(/#key=/g)).toHaveLength(1);
    expect(
      linksText(
        [
          {...link, name: 'A\nB\tC'},
          {...link, revoked: true},
        ],
        'https://vote.test',
      ),
    ).toBe(`A B C\thttps://vote.test/vote/${id}#key=${token}`);
  });
  it.each(['', '-1', '1.2', '1e2', '01', '9223372036854775808'])(
    'rejects an invalid cursor %s',
    (value) => expect(validCursor(value)).toBe(false),
  );
  it('accepts the bigint boundary without losing precision', () =>
    expect(validCursor('9223372036854775807')).toBe(true));
});

describe('link browser boundary', () => {
  it('strips private fields from normal lists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          links: [{...link, cipher: 'private', hash: 'private'}],
          nextCursor: null,
        }),
      ),
    );
    const response = await adminLinkProxy(request(), room);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      links: [
        {
          id,
          name: 'Name',
          mode: 'personal',
          ordinal: '1',
          revision: '0',
          revoked: false,
        },
      ],
      nextCursor: null,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({Authorization: `Bearer ${token}`}),
        redirect: 'error',
      }),
    );
  });
  it('requires the matching admin cookie and rejects cross-site writes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(
      (
        await adminLinkProxy(
          request('GET', undefined, {Cookie: `vm_vote_${id}=${token}`}),
          room,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await adminLinkProxy(
          request('POST', {}, {Origin: 'https://evil.test'}),
          room,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await adminLinkProxy(
          request('POST', {}, {'Content-Type': 'text/plain'}),
          room,
        )
      ).status,
    ).toBe(415);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    {},
    {mode: 'other', names: ['A']},
    {mode: 'personal', names: []},
    {mode: 'personal', names: ['A', 'x'.repeat(201)]},
    {mode: 'personal', names: Array(101).fill('A')},
  ])('rejects a bad batch before calling the API', async (body) => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await adminLinkProxy(request('POST', body), room)).status).toBe(
      400,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('hides backend errors and rejects malformed metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({error: 'secret SQL'}, {status: 500})),
    );
    const response = await adminLinkProxy(request(), room);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('SQL');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({links: [link], nextCursor: '-1'})),
    );
    expect((await adminLinkProxy(request(), room)).status).toBe(502);
  });
  it('stores participant sessions separately and does not expose the session key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          participant: {...participant, private: token},
          sessionToken: token,
        }),
      ),
    );
    const response = await participantProxy(request('POST', {token}), id, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({participant});
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${votingCookie(id)}=`);
    expect(cookie).toContain(`Path=/api/vote/${id}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=strict');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain(`vm_room_${room}`);
  });
  it('rejects admin cookies as participant sessions and foreign link payloads', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await participantProxy(request(), id)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          participant: {...participant, linkId: room},
          sessionToken: token,
        }),
      ),
    );
    expect(
      (await participantProxy(request('POST', {token}), id, true)).status,
    ).toBe(502);
  });
});
