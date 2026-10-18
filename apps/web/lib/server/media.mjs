import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const execute = promisify(execFile);
export const maxBytes = 10 * 1024 * 1024;
export const maxPixels = 25000000;
// A short safe error can be shown by the upload route
export class MediaError extends Error {
  // HTTP status shown by the upload route
  status;
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
// Check dimensions before decoding a full frame
function dimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > maxPixels
  )
    throw new MediaError('Не более 25 мегапикселей на кадр');
}
// Child processes keep video work out of the HTTP event loop
async function tool(binary, args) {
  try {
    return await execute(binary, args, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
  } catch {
    throw new MediaError('Не удалось обработать файл');
  }
}
// Use a full decoder, with no limit on duration or frame count
async function validateVideo(path, format) {
  await tool('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-xerror',
    '-err_detect',
    'explode',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    format,
    '-max_pixels',
    String(maxPixels),
    '-threads',
    '2',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-an',
    '-f',
    'null',
    '-',
  ]);
}
// Parse a short WebP chunk without trusting its size
function webpChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}
// Build a container using only validated chunks
function webpFile(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
// Strip animation metadata while validating one frame at a time
async function animatedWebp(input, deadline) {
  const end = input.readUInt32LE(4) + 8;
  if (end > input.length || end < 12)
    throw new MediaError('Поврежденный файл WebP');
  const chunks = [];
  let width = 0;
  let height = 0;
  let frames = 0;
  let animation = false;
  for (let offset = 12; offset < end; ) {
    if (Date.now() > deadline)
      throw new MediaError('Обработка файла заняла слишком много времени');
    if (offset + 8 > end) throw new MediaError('Поврежденный файл WebP');
    const type = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size % 2);
    if (next > end) throw new MediaError('Поврежденный файл WebP');
    const data = input.subarray(offset + 8, offset + 8 + size);
    if (type === 'VP8X') {
      if (size !== 10) throw new MediaError('Поврежденный файл WebP');
      width = data.readUIntLE(4, 3) + 1;
      height = data.readUIntLE(7, 3) + 1;
      dimensions(width, height);
      animation = Boolean(data[0] & 2);
      const clean = Buffer.from(data);
      clean[0] &= 0x12;
      chunks.push(webpChunk(type, clean));
    } else if (type === 'ANIM') {
      if (size !== 6) throw new MediaError('Поврежденный файл WebP');
      chunks.push(webpChunk(type, data));
    } else if (type === 'ANMF') {
      if (size < 16 || !animation || data[15] & 0xfc)
        throw new MediaError('Поврежденный файл WebP');
      const x = data.readUIntLE(0, 3) * 2;
      const y = data.readUIntLE(3, 3) * 2;
      const w = data.readUIntLE(6, 3) + 1;
      const h = data.readUIntLE(9, 3) + 1;
      dimensions(w, h);
      if (x + w > width || y + h > height)
        throw new MediaError('Поврежденный кадр WebP');
      const frame = [];
      let image = false;
      let alpha = false;
      for (let part = 16; part < size; ) {
        if (part + 8 > size) throw new MediaError('Поврежденный кадр WebP');
        const kind = data.toString('ascii', part, part + 4);
        const length = data.readUInt32LE(part + 4);
        const stop = part + 8 + length + (length % 2);
        if (stop > size || !['ALPH', 'VP8 ', 'VP8L'].includes(kind))
          throw new MediaError('Поврежденный кадр WebP');
        const bytes = data.subarray(part + 8, part + 8 + length);
        if (kind === 'ALPH') alpha = true;
        else {
          if (image) throw new MediaError('Поврежденный кадр WebP');
          image = true;
          if (kind === 'VP8L' && bytes.length >= 5)
            alpha = Boolean(bytes[4] & 16);
        }
        frame.push(webpChunk(kind, bytes));
        part = stop;
      }
      if (!image) throw new MediaError('Пустой кадр WebP');
      const extended = Buffer.alloc(10);
      extended[0] = alpha ? 16 : 0;
      extended.writeUIntLE(w - 1, 4, 3);
      extended.writeUIntLE(h - 1, 7, 3);
      await sharp(webpFile([webpChunk('VP8X', extended), ...frame]), {
        limitInputPixels: maxPixels,
        failOn: 'warning',
      }).stats();
      chunks.push(webpChunk(type, data));
      frames++;
    } else if (!['ICCP', 'EXIF', 'XMP '].includes(type)) {
      if (animation) throw new MediaError('Поврежденный файл WebP');
    }
    offset = next;
  }
  if (!animation) return null;
  if (!frames) throw new MediaError('Пустая анимация WebP');
  return {data: webpFile(chunks), mime: 'image/webp', width, height};
}
// Return the end of a GIF data sequence
function gifBlocks(input, start) {
  let offset = start;
  while (offset < input.length) {
    const size = input[offset++];
    if (size === 0) return offset;
    if (offset + size > input.length) break;
    offset += size;
  }
  throw new MediaError('Поврежденный файл GIF');
}
// Keep frame timing and loop count, but remove comments and other metadata
function cleanGif(input) {
  if (input.length < 13) throw new MediaError('Поврежденный файл GIF');
  const width = input.readUInt16LE(6);
  const height = input.readUInt16LE(8);
  dimensions(width, height);
  let offset = 13 + (input[10] & 128 ? 3 * 2 ** ((input[10] & 7) + 1) : 0);
  if (offset > input.length) throw new MediaError('Поврежденный файл GIF');
  const parts = [input.subarray(0, offset)];
  let frames = 0;
  let ended = false;
  while (offset < input.length) {
    const start = offset;
    const type = input[offset++];
    if (type === 0x3b) {
      parts.push(Buffer.from([0x3b]));
      ended = true;
      break;
    }
    if (type === 0x2c) {
      if (start + 10 > input.length)
        throw new MediaError('Поврежденный кадр GIF');
      const x = input.readUInt16LE(start + 1);
      const y = input.readUInt16LE(start + 3);
      const w = input.readUInt16LE(start + 5);
      const h = input.readUInt16LE(start + 7);
      dimensions(w, h);
      if (x + w > width || y + h > height)
        throw new MediaError('Поврежденный кадр GIF');
      offset =
        start +
        10 +
        (input[start + 9] & 128 ? 3 * 2 ** ((input[start + 9] & 7) + 1) : 0);
      if (offset >= input.length) throw new MediaError('Поврежденный файл GIF');
      offset = gifBlocks(input, offset + 1);
      parts.push(input.subarray(start, offset));
      frames++;
    } else if (type === 0x21) {
      if (offset >= input.length) throw new MediaError('Поврежденный файл GIF');
      const label = input[offset++];
      const end = gifBlocks(input, offset);
      if (label === 0xf9) {
        if (input[offset] !== 4 || end - offset !== 6)
          throw new MediaError('Поврежденный файл GIF');
        parts.push(input.subarray(start, end));
      }
      if (
        label === 0xff &&
        input[offset] === 11 &&
        ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(
          input.toString('ascii', offset + 1, offset + 12),
        ) &&
        input[offset + 12] === 3 &&
        input[offset + 13] === 1
      )
        parts.push(
          Buffer.concat([
            Buffer.from([0x21, 0xff, 11]),
            Buffer.from('NETSCAPE2.0'),
            Buffer.from([3, 1, input[offset + 14], input[offset + 15], 0]),
          ]),
        );
      offset = end;
    } else {
      throw new MediaError('Поврежденный файл GIF');
    }
  }
  if (!ended || !frames) throw new MediaError('Пустой файл GIF');
  return {data: Buffer.concat(parts), mime: 'image/gif', width, height};
}

// Read one EBML value without trusting a size from the file
function ebmlValue(input, offset, identifier = false) {
  if (offset >= input.length) throw new MediaError('Поврежденный файл WebM');
  let mask = 128;
  let length = 1;
  while (length <= 8 && !(input[offset] & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > input.length)
    throw new MediaError('Поврежденный файл WebM');
  let value = identifier ? input[offset] : input[offset] & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + input[offset + i];
  if (!Number.isSafeInteger(value))
    throw new MediaError('Поврежденный файл WebM');
  return {value, next: offset + length};
}
// Reject arbitrary input formats and external playlists
function isWebm(input) {
  if (input.length < 5 || input.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const header = ebmlValue(input, 4);
  const end = header.next + header.value;
  if (end > input.length) throw new MediaError('Поврежденный файл WebM');
  for (let offset = header.next; offset < end; ) {
    const id = ebmlValue(input, offset, true);
    const size = ebmlValue(input, id.next);
    const stop = size.next + size.value;
    if (stop > end) throw new MediaError('Поврежденный файл WebM');
    if (id.value === 0x4282)
      return input.toString('ascii', size.next, stop) === 'webm';
    offset = stop;
  }
  return false;
}
// Look at file signatures instead of trusting a name or browser MIME type
function format(input) {
  if (input.length >= 2 && input[0] === 255 && input[1] === 10) return 'jxl';
  if (input.length < 12) throw new MediaError('Файл пуст или поврежден');
  if (
    input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (input[0] === 255 && input[1] === 216 && input[2] === 255) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(input.toString('ascii', 0, 6)))
    return 'gif';
  if (
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  if (
    (input[0] === 255 && input[1] === 10) ||
    input
      .subarray(0, 12)
      .equals(Buffer.from([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]))
  )
    return 'jxl';
  if (isWebm(input)) return 'webm';
  for (let offset = 0; offset + 8 <= input.length; ) {
    let size = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    let head = 8;
    if (size === 1) {
      if (offset + 16 > input.length) break;
      const large = input.readBigUInt64BE(offset + 8);
      if (large > BigInt(input.length)) break;
      size = Number(large);
      head = 16;
    }
    if (size < head || offset + size > input.length) break;
    if (type === 'ftyp') {
      const brands = input.toString('ascii', offset + head, offset + size);
      if (brands.includes('avis'))
        throw new MediaError('Анимация поддерживается в GIF и WebP', 415);
      return brands.includes('avif') ? 'avif' : 'mp4';
    }
    offset += size;
  }
  throw new MediaError('Неподдерживаемый формат файла', 415);
}
// Convert static pictures to a browser format and remove metadata
async function staticImage(input) {
  const image = sharp(input, {limitInputPixels: maxPixels, failOn: 'warning'});
  const info = await image.metadata();
  dimensions(info.width, info.height);
  if ((info.pages ?? 1) > 1)
    throw new MediaError('Анимация поддерживается в GIF и WebP', 415);
  const result = await image
    .rotate()
    .webp({quality: 90})
    .timeout({seconds: 30})
    .toBuffer({resolveWithObject: true});
  dimensions(result.info.width, result.info.height);
  return {
    data: result.data,
    mime: 'image/webp',
    width: result.info.width,
    height: result.info.height,
  };
}
// Keep the source codec and frames while removing container metadata
async function video(path, directory, kind) {
  const demuxer = kind === 'mp4' ? 'mov' : 'matroska';
  const probe = await tool('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    demuxer,
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name',
    '-of',
    'json',
    path,
  ]);
  const info = JSON.parse(probe.stdout).streams?.[0];
  if (!info) throw new MediaError('В файле нет видеодорожки');
  dimensions(info.width, info.height);
  await validateVideo(path, demuxer);
  const output = join(directory, `output.${kind}`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    demuxer,
    '-i',
    path,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-map_metadata',
    '-1',
    '-map_metadata:s:v',
    '-1',
    '-map_metadata:s:a',
    '-1',
    '-map_chapters',
    '-1',
  ];
  // Remove user-data SEI blocks without changing the video frames
  if (info.codec_name === 'h264')
    args.push('-bsf:v', 'filter_units=remove_types=6');
  if (info.codec_name === 'hevc')
    args.push('-bsf:v', 'filter_units=remove_types=39|40');
  if (kind === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', kind === 'mp4' ? 'mp4' : 'webm', output);
  await tool('ffmpeg', args);
  if ((await stat(output)).size > maxBytes)
    throw new MediaError('Обработанный файл превышает 10 MiB', 413);
  return {
    data: await readFile(output),
    mime: `video/${kind}`,
    width: info.width,
    height: info.height,
  };
}
// Process one bounded upload and always remove local temporary files
export async function processMedia(input, declaredType = '') {
  if (!input.length) throw new MediaError('Файл пуст');
  if (input.length > maxBytes)
    throw new MediaError('Не более 10 MiB на файл', 413);
  const kind = format(input);
  const expected =
    kind === 'mp4' || kind === 'webm' ? `video/${kind}` : `image/${kind}`;
  if (
    declaredType &&
    declaredType !== 'application/octet-stream' &&
    declaredType !== expected
  )
    throw new MediaError('Тип файла не соответствует содержимому', 415);
  const directory = await mkdtemp(join(tmpdir(), 'votebox-media-'));
  try {
    const path = join(directory, 'input');
    await writeFile(path, input, {mode: 0o600});
    let result;
    if (kind === 'mp4' || kind === 'webm')
      result = await video(path, directory, kind);
    else if (kind === 'gif') {
      result = cleanGif(input);
      await validateVideo(path, 'gif');
    } else if (kind === 'jxl') {
      const metadata = await tool('jxlinfo', [path]);
      const match = /([0-9]+)x([0-9]+)/.exec(metadata.stdout + metadata.stderr);
      if (
        !match ||
        /animation|animated/i.test(metadata.stdout + metadata.stderr)
      )
        throw new MediaError('Анимация поддерживается в GIF и WebP', 415);
      dimensions(Number(match[1]), Number(match[2]));
      const decoded = join(directory, 'decoded.png');
      await tool('djxl', [path, decoded, '--num_threads=2', '--quiet']);
      result = await staticImage(decoded);
    } else if (kind === 'webp')
      result =
        (await animatedWebp(input, Date.now() + 120000)) ??
        (await staticImage(input));
    else result = await staticImage(input);
    if (result.data.length > maxBytes)
      throw new MediaError('Обработанный файл превышает 10 MiB', 413);
    return result;
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message))
      throw new MediaError('Не более 25 мегапикселей на кадр');
    throw new MediaError('Файл поврежден или не поддерживается');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
