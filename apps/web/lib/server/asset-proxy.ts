import {NextResponse} from 'next/server';
import {createHash} from 'node:crypto';
import {roomIdPattern} from '../rooms';
import {savedRooms, sameOrigin} from '../recent-rooms';
import {votingCookie} from '../link-proxy';
import {secretPattern} from '../rooms';
import {isAsset, publicAsset, maxUploadBytes} from '../assets';
import {processMedia, MediaError} from './media.mjs';
import {putObject, getObject, headObject} from './storage.mjs';

const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
let processing = 0;
// Return short errors without object keys or storage credentials
function failure(status: number, message = 'Файл недоступен') {
  return NextResponse.json({error: message}, {status, headers});
}
// Keep internal failures separate from bad input
class AccessError extends Error {
  // Public HTTP status for this failure
  status: number;
  constructor(status: number) {
    super('Media request failed');
    this.status = status;
  }
}
// Read the matching room session, never a participant cookie
function adminToken(request: Request, room: string) {
  if (!roomIdPattern.test(room)) throw new AccessError(401);
  const token = savedRooms(request).find((entry) => entry.id === room)?.token;
  if (!token) throw new AccessError(401);
  return token;
}
// Authorize each operation through the C++ API
async function backend(
  path: string,
  token: string,
  body?: unknown,
  worker = false,
) {
  const response = await fetch(
    new URL(path, process.env.API_ORIGIN ?? 'http://api:8080'),
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(worker
          ? {'X-Media-Worker': process.env.MEDIA_WORKER_KEY ?? ''}
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!response.ok)
    throw new AccessError(
      [400, 401, 403, 404, 409, 413, 415].includes(response.status)
        ? response.status
        : 503,
    );
  return response.json();
}
// Stop reading once the upload exceeds its file and form allowance
async function uploadForm(request: Request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data;'))
    throw new AccessError(415);
  const limit = maxUploadBytes + 65536;
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new AccessError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AccessError(413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const form = await new Response(Buffer.concat(chunks), {
    headers: {'Content-Type': type},
  }).formData();
  const file = form.get('file');
  if (
    !(file instanceof File) ||
    form.getAll('file').length !== 1 ||
    file.size === 0
  )
    throw new AccessError(400);
  if (file.size > maxUploadBytes) throw new AccessError(413);
  return file;
}
// Validate, normalize and upload only after the room access check
export async function uploadAsset(request: Request, room: string) {
  if (!sameOrigin(request)) return failure(403);
  let claimed = false;
  try {
    const token = adminToken(request, room);
    await backend(`/api/rooms/${room}/assets/access`, token);
    if (processing >= 2)
      return failure(503, 'Загрузка занята, попробуйте снова');
    processing++;
    claimed = true;
    const file = await uploadForm(request);
    const reserved = await backend(`/api/rooms/${room}/assets`, token, {
      bytes: file.size,
    });
    const id = reserved.asset?.id;
    if (
      typeof id !== 'string' ||
      !roomIdPattern.test(id) ||
      reserved.asset?.objectKey !== `rooms/${room}/${id}`
    )
      throw new Error('Invalid reservation');
    const result = await processMedia(
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );
    await putObject(
      reserved.asset.objectKey,
      result.data,
      result.mime,
      AbortSignal.timeout(30000),
    );
    const finished = await backend(
      `/api/rooms/${room}/assets/${id}/finish`,
      token,
      {
        mime: result.mime,
        width: result.width,
        height: result.height,
        bytes: result.data.length,
        sha256: createHash('sha256').update(result.data).digest('hex'),
      },
      true,
    );
    if (!isAsset(finished.asset) || finished.asset.id !== id)
      throw new Error('Invalid media');
    return NextResponse.json(
      {id, kind: finished.asset.kind, source: `asset:${id}`},
      {status: 201, headers},
    );
  } catch (error) {
    if (error instanceof MediaError)
      return failure(error.status, error.message);
    const status = error instanceof AccessError ? error.status : 503;
    return failure(
      status,
      status === 413
        ? 'Не более 10 MiB на файл'
        : status === 415
          ? 'Неподдерживаемый формат файла'
          : status === 401
            ? 'Нет доступа к комнате'
            : 'Не удалось загрузить файл, попробуйте снова',
    );
  } finally {
    if (claimed) processing--;
  }
}
// Read metadata using the cookie path for this viewer role
async function assetData(
  request: Request,
  owner: string,
  id: string,
  participant: boolean,
) {
  if (!roomIdPattern.test(owner) || !roomIdPattern.test(id))
    throw new AccessError(401);
  let token: string | undefined;
  if (participant) {
    token = request.headers
      .get('cookie')
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${votingCookie(owner)}=`))
      ?.split('=')[1];
    if (!token || !secretPattern.test(token)) throw new AccessError(401);
  } else token = adminToken(request, owner);
  const body = await backend(
    participant
      ? `/api/vote/${owner}/assets/${id}`
      : `/api/rooms/${owner}/assets/${id}`,
    token,
  );
  if (
    !isAsset(body.asset) ||
    body.asset.id !== id ||
    typeof body.asset.objectKey !== 'string'
  )
    throw new Error('Invalid asset');
  const key = body.asset.objectKey;
  const pieces = key.split('/');
  if (
    pieces.length !== 3 ||
    pieces[0] !== 'rooms' ||
    !roomIdPattern.test(pieces[1]) ||
    pieces[2] !== id ||
    (!participant && pieces[1] !== owner)
  )
    throw new Error('Invalid object key');
  return {...publicAsset(body.asset), objectKey: key};
}
// Public metadata never contains an S3 key or URL
export async function assetInfo(
  request: Request,
  owner: string,
  id: string,
  participant = false,
) {
  try {
    const asset = await assetData(request, owner, id, participant);
    return NextResponse.json({asset: publicAsset(asset)}, {headers});
  } catch (error) {
    return failure(error instanceof AccessError ? error.status : 503);
  }
}
// Keep video seeking private and allow only a single byte range
export async function assetBytes(
  request: Request,
  owner: string,
  id: string,
  participant = false,
) {
  try {
    const asset = await assetData(request, owner, id, participant);
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      return new NextResponse(null, {
        status: 416,
        headers: {...headers, 'Content-Range': `bytes */${asset.bytes}`},
      });
    const stored =
      request.method === 'HEAD'
        ? await headObject(asset.objectKey, request.signal)
        : await getObject(asset.objectKey, range ?? undefined, request.signal);
    const outgoing: Record<string, string> = {
      ...headers,
      'Content-Type': asset.mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline',
    };
    if (typeof stored.ContentLength === 'number')
      outgoing['Content-Length'] = String(stored.ContentLength);
    if ('ContentRange' in stored && typeof stored.ContentRange === 'string')
      outgoing['Content-Range'] = stored.ContentRange;
    const body =
      request.method === 'HEAD'
        ? null
        : 'Body' in stored
          ? stored.Body?.transformToWebStream()
          : null;
    if (request.method !== 'HEAD' && !body) throw new Error('Missing object');
    return new NextResponse(body, {
      status: outgoing['Content-Range'] ? 206 : 200,
      headers: outgoing,
    });
  } catch (error) {
    if (error instanceof AccessError) return failure(error.status);
    const status = (error as {$metadata?: {httpStatusCode?: number}})?.$metadata
      ?.httpStatusCode;
    return failure(status === 404 ? 404 : status === 416 ? 416 : 503);
  }
}
// Active unsaved references renew their deletion grace period
export async function keepAssets(request: Request, room: string) {
  if (!sameOrigin(request)) return failure(403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return failure(415);
  try {
    const token = adminToken(request, room);
    const text = await request.text();
    if (text.length > 600000) return failure(413);
    const data = JSON.parse(text);
    if (
      !Array.isArray(data?.ids) ||
      data.ids.length > 12000 ||
      !data.ids.every(
        (id: unknown) => typeof id === 'string' && roomIdPattern.test(id),
      )
    )
      return failure(400);
    await backend(`/api/rooms/${room}/assets/keepalive`, token, {
      ids: data.ids,
    });
    return NextResponse.json({}, {headers});
  } catch (error) {
    return failure(
      error instanceof AccessError
        ? error.status
        : error instanceof SyntaxError
          ? 400
          : 503,
    );
  }
}
