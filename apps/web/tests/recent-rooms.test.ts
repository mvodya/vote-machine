import {describe, expect, it, vi} from 'vitest';
import {NextResponse} from 'next/server';
import {
  roomCookieName,
  roomCookieValue,
  savedRooms,
  rememberRoom,
} from '../lib/recent-rooms';
import {GET} from '../app/api/recent-rooms/route';
import {DELETE} from '../app/api/recent-rooms/[id]/route';
const first = {
  id: 'a96c3a49-0198-4545-8dce-44b70c86494d',
  name: 'Первая',
  token: 'a'.repeat(64),
  usedAt: 1,
};
const second = {
  ...first,
  id: 'b96c3a49-0198-4545-8dce-44b70c86494d',
  name: 'Вторая',
  token: 'b'.repeat(64),
  usedAt: 2,
};
// Build one saved room cookie for a test
const cookie = (item: typeof first) =>
  `${roomCookieName(item.id)}=${roomCookieValue(item)}`;
// Build a request with saved room cookies
const request = (cookies = `${cookie(first)}; ${cookie(second)}`) =>
  new Request('https://vote.test/api/recent-rooms', {
    headers: {Cookie: cookies, Origin: 'https://vote.test'},
  });

describe('Recent room cookies', () => {
  it('lists cached names in last-use order without exposing tokens', async () => {
    const response = await GET(request());
    expect(await response.json()).toEqual({
      rooms: [
        {id: second.id, name: 'Вторая'},
        {id: first.id, name: 'Первая'},
      ],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('ignores damaged records and invalid secrets', () => {
    expect(savedRooms(request(`${roomCookieName(first.id)}=broken`))).toEqual(
      [],
    );
    expect(savedRooms(request(cookie({...first, token: 'bad'})))).toEqual([]);
  });
  it('refreshes only the selected room name and token', () => {
    const response = NextResponse.json({});
    rememberRoom(
      response,
      request(),
      {
        id: first.id,
        name: 'Новое название',
        createdAt: '2026-10-25T00:00:00Z',
        revision: '1',
      },
      first.token,
    );
    const combined = `${cookie(second)}; ${response.headers.get('set-cookie')!.split(';')[0]}`;
    expect(savedRooms(request(combined)).map((item) => item.name)).toEqual([
      'Новое название',
      'Вторая',
    ]);
    expect(response.cookies.get(roomCookieName(second.id))).toBeUndefined();
  });
  it('removes only the chosen browser record without contacting the backend', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await DELETE(request(), {
      params: Promise.resolve({id: first.id}),
    });
    expect(response.status).toBe(200);
    expect(response.cookies.get(roomCookieName(first.id))?.value).toBe('');
    expect(response.cookies.get(roomCookieName(second.id))).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects a foreign attempt to remove a room', async () => {
    const response = await DELETE(
      new Request('https://vote.test/api/recent-rooms', {
        headers: {Origin: 'https://foreign.test'},
      }),
      {params: Promise.resolve({id: first.id})},
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('keeps separate cookie writes from simultaneous room visits', () => {
    const a = NextResponse.json({});
    const b = NextResponse.json({});
    for (const [response, room] of [
      [a, first],
      [b, second],
    ] as const)
      rememberRoom(
        response,
        request(''),
        {...room, createdAt: '2026-10-25T00:00:00Z', revision: '0'},
        room.token,
      );
    const combined = `${a.headers.get('set-cookie')!.split(';')[0]}; ${b.headers.get('set-cookie')!.split(';')[0]}`;
    expect(savedRooms(request(combined))).toHaveLength(2);
  });
});
