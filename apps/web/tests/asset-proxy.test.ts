import {expect, it, vi} from 'vitest';
import {
  assetInfo,
  assetBytes,
  keepAssets,
  uploadAsset,
} from '../lib/server/asset-proxy';
import {roomCookieValue} from '../lib/recent-rooms';

const storage = vi.hoisted(() => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock('../lib/server/storage.mjs', () => storage);
const room = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const id = 'b96c3a49-0198-4545-8dce-44b70c86494d';
const token = 'a'.repeat(64);
const cookie = `vm_room_${room}=${roomCookieValue({id: room, name: 'Room', token, usedAt: 1})}`;
const asset = {
  id,
  kind: 'video',
  mime: 'video/mp4',
  width: 2,
  height: 2,
  bytes: 100,
  objectKey: `rooms/${room}/${id}`,
  private: token,
};
// Use only this room's saved session at the browser boundary
function request(
  method = 'GET',
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return new Request(`https://vote.test/api/rooms/${room}/assets/${id}`, {
    method,
    headers: {Cookie: cookie, Origin: 'https://vote.test', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
it('rejects missing or wrong-role cookies before any storage read', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  storage.getObject.mockClear();
  expect(
    (await assetBytes(request('GET', {Cookie: ''}), room, id)).status,
  ).toBe(401);
  expect((await assetInfo(request(), room, id, true)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  expect(storage.getObject).not.toHaveBeenCalled();
});
it('keeps object keys and private fields out of public descriptors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({asset})));
  const response = await assetInfo(request(), room, id);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    asset: {
      id,
      kind: 'video',
      mime: 'video/mp4',
      width: 2,
      height: 2,
      bytes: 100,
    },
  });
  expect(response.headers.get('cache-control')).toContain('no-store');
});
it('does not use an object key belonging to another room', async () => {
  storage.getObject.mockClear();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({asset: {...asset, objectKey: `rooms/${id}/${id}`}}),
      ),
  );
  expect((await assetBytes(request(), room, id)).status).toBe(503);
  expect(storage.getObject).not.toHaveBeenCalled();
});
it('passes one private range through and rejects multipart ranges', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(Response.json({asset}))),
  );
  storage.getObject.mockClear();
  storage.getObject.mockResolvedValue({
    ContentLength: 2,
    ContentRange: 'bytes 0-1/100',
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
    },
  });
  const response = await assetBytes(
    request('GET', {Range: 'bytes=0-1'}),
    room,
    id,
  );
  expect(response.status).toBe(206);
  expect(response.headers.get('content-type')).toBe('video/mp4');
  expect(response.headers.get('content-range')).toBe('bytes 0-1/100');
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
  storage.getObject.mockClear();
  const rejected = await assetBytes(
    request('GET', {Range: 'bytes=0-1,4-5'}),
    room,
    id,
  );
  expect(rejected.status).toBe(416);
  expect(storage.getObject).not.toHaveBeenCalled();
});
it('checks Origin before uploads or heartbeat writes', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(
    (await uploadAsset(request('POST', {Origin: 'https://evil.test'}), room))
      .status,
  ).toBe(403);
  expect(
    (await keepAssets(request('POST', {Origin: 'https://evil.test'}, {}), room))
      .status,
  ).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not reveal internal errors when access checks fail', async () => {
  storage.getObject.mockClear();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({error: `private ${token}`}, {status: 500}),
      ),
  );
  const response = await assetBytes(request(), room, id);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(token);
  expect(storage.getObject).not.toHaveBeenCalled();
});
