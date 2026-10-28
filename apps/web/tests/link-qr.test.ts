import {expect, it, vi} from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import {linkQr} from '../lib/server/link-qr';
import {adminLinkProxy} from '../lib/link-proxy';
import {roomCookieValue} from '../lib/recent-rooms';
const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const link = 'b96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
const secret = 'c'.repeat(64);
// Keep test access scoped to one room
function request(method = 'GET', body?: unknown) {
  return new Request(`https://vote.test/api/rooms/${room}/links/${link}/qr`, {
    method,
    headers: {
      Cookie: `vm_room_${room}=${roomCookieValue({id: room, name: 'Room', token, usedAt: 1})}`,
      Origin: 'https://vote.test',
      'Content-Type': 'application/json',
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
}
it('makes a readable PNG with the exact link and private cache headers', async () => {
  vi.stubEnv('PUBLIC_ORIGIN', 'https://vote.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({token: secret})),
  );
  const response = await linkQr(request(), room, link);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const {data, info} = await sharp(Buffer.from(await response.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  expect(decoded?.data).toBe(`https://vote.test/vote/${link}#key=${secret}`);
});
it('blocks missing, wrong-room and revoked access before returning a QR image', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({error: 'Missing'}, {status: 404}),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(
    (await linkQr(new Request('https://vote.test'), room, link)).status,
  ).toBe(401);
  expect((await linkQr(request(), link, room)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await linkQr(request(), room, link);
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).not.toBe('image/png');
});
it('validates the history flag and copies it through the checked edit path', async () => {
  const item = {
    id: link,
    name: 'Shared',
    mode: 'reusable',
    ordinal: '1',
    revision: '1',
    revoked: false,
    allowRunHistory: true,
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({link: item}));
  vi.stubGlobal('fetch', fetcher);
  const saved = await adminLinkProxy(
    request('PATCH', {action: 'rename', name: 'Shared', allowRunHistory: true}),
    room,
    link,
  );
  expect(saved.status).toBe(200);
  expect((await saved.json()).link.allowRunHistory).toBe(true);
  expect(
    JSON.parse(String(fetcher.mock.calls[0][1]?.body)).allowRunHistory,
  ).toBe(true);
  const invalid = await adminLinkProxy(
    request('PATCH', {
      action: 'rename',
      name: 'Shared',
      allowRunHistory: 'true',
    }),
    room,
    link,
  );
  expect(invalid.status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
