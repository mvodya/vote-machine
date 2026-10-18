import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = process.env.MEDIA_TEST_ROOT ?? '/app/apps/web';
const require = createRequire(`${root}/package.json`);
const sharp = require('sharp');
const execute = promisify(execFile);
const marker = 'Votebox private media marker';
// Build real tiny media files with the decoders shipped in the runtime
async function fixtures(directory) {
  const png = await sharp({
    create: {width: 2, height: 2, channels: 3, background: '#336699'},
  })
    .withMetadata({exif: {IFD0: {Artist: marker}}})
    .png()
    .toBuffer();
  const image = () =>
    sharp({create: {width: 2, height: 2, channels: 3, background: '#336699'}});
  const raw = Buffer.alloc(32);
  for (let pixel = 0; pixel < 8; pixel++) {
    raw[pixel * 4 + (pixel < 4 ? 0 : 1)] = 255;
    raw[pixel * 4 + 3] = 255;
  }
  const animation = () =>
    sharp(raw, {raw: {width: 2, height: 4, channels: 4, pageHeight: 2}});
  const gif = await animation()
    .gif({delay: [80, 120], loop: 2})
    .toBuffer();
  const gifWithComment = Buffer.concat([
    gif.subarray(0, -1),
    Buffer.from([0x21, 0xfe, marker.length]),
    Buffer.from(marker),
    Buffer.from([0, 0x3b]),
  ]);
  const webp = await animation()
    .webp({lossless: true, delay: [80, 120], loop: 2})
    .toBuffer();
  const chunk = Buffer.alloc(8);
  chunk.write('EXIF');
  chunk.writeUInt32LE(marker.length, 4);
  const animated = Buffer.concat([
    webp,
    chunk,
    Buffer.from(marker),
    ...(marker.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
  animated.writeUInt32LE(animated.length - 8, 4);
  animated[20] |= 8;
  const frameCount = 1001;
  const longRaw = Buffer.alloc(frameCount * 16);
  for (let frame = 0; frame < frameCount; frame++)
    for (let pixel = 0; pixel < 4; pixel++) {
      longRaw[frame * 16 + pixel * 4 + (frame % 2)] = 255;
      longRaw[frame * 16 + pixel * 4 + 3] = 255;
    }
  const longAnimation = () =>
    sharp(longRaw, {
      raw: {width: 2, height: frameCount * 2, channels: 4, pageHeight: 2},
    });
  const longGif = await longAnimation()
    .gif({delay: Array(frameCount).fill(10), loop: 2})
    .toBuffer();
  const longWebp = await longAnimation()
    .webp({lossless: true, delay: Array(frameCount).fill(10), loop: 2})
    .toBuffer();
  const source = join(directory, 'source.png');
  await writeFile(source, png);
  const jxl = join(directory, 'source.jxl');
  await execute('cjxl', [source, jxl], {timeout: 30000});
  const mp4 = join(directory, 'source.mp4');
  const webm = join(directory, 'source.webm');
  await execute(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-i',
      source,
      '-t',
      '360',
      '-r',
      '1',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-metadata',
      `title=${marker}`,
      mp4,
    ],
    {timeout: 30000},
  );
  await execute(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-i',
      source,
      '-t',
      '0.2',
      '-c:v',
      'libvpx-vp9',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-metadata',
      `title=${marker}`,
      webm,
    ],
    {timeout: 30000},
  );
  return [
    {name: 'png', type: 'image/png', data: png},
    {name: 'jpeg', type: 'image/jpeg', data: await image().jpeg().toBuffer()},
    {name: 'webp', type: 'image/webp', data: await image().webp().toBuffer()},
    {
      name: 'avif',
      type: 'image/avif',
      data: await image().avif({effort: 0}).toBuffer(),
    },
    {name: 'jxl', type: 'image/jxl', data: await readFile(jxl)},
    {name: 'gif', type: 'image/gif', data: gifWithComment},
    {name: 'gif-long', type: 'image/gif', data: longGif, frames: 1001},
    {
      name: 'animated-webp-long',
      type: 'image/webp',
      data: longWebp,
      frames: 1001,
    },
    {name: 'animated-webp', type: 'image/webp', data: animated},
    {name: 'mp4', type: 'video/mp4', data: await readFile(mp4)},
    {name: 'webm', type: 'video/webm', data: await readFile(webm)},
  ];
}
// Exercise the complete upload pipeline without printing secrets
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'votebox-media-test-'));
  try {
    const media = await fixtures(directory);
    if (process.env.MEDIA_FIXTURES_ONLY === '1') {
      const {processMedia} = await import(`${root}/lib/server/media.mjs`);
      for (const file of media) {
        const value = await processMedia(file.data, file.type);
        assert.equal(value.width, 2);
        assert.equal(value.height, 2);
        assert(!value.data.includes(Buffer.from(marker)));
        console.log(`${file.name}: ${value.mime}, ${value.data.length} bytes`);
      }
      return;
    }
    const origin = 'http://localhost:3000';
    // Use private web routes with real cookies and same-site headers
    async function call(
      path,
      {method = 'GET', body, cookie, form, headers: extra = {}} = {},
    ) {
      return fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? {Cookie: cookie} : {}),
          ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
          ...extra,
        },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(180000),
      });
    }
    // Give every access check a separate real room
    async function admin(name) {
      const created = await call('/api/rooms', {method: 'POST', body: {name}});
      assert.equal(created.status, 201);
      const {room, adminToken} = await created.json();
      const response = await call(`/api/rooms/${room.id}/session`, {
        method: 'POST',
        body: {token: adminToken},
      });
      assert.equal(response.status, 200);
      return {
        room,
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      };
    }
    const owner = await admin('Media API');
    const other = await admin('Other media');
    // Real multipart data must pass both access and format checks
    async function upload(file, cookie = owner.cookie) {
      const form = new FormData();
      form.set('file', new File([file.data], file.name, {type: file.type}));
      return call(`/api/rooms/${owner.room.id}/assets`, {
        method: 'POST',
        cookie,
        form,
      });
    }
    assert.equal((await upload(media[0], other.cookie)).status, 401);
    const assets = [];
    for (const file of media) {
      const uploaded = await upload(file);
      const body = await uploaded.json();
      assert.equal(
        uploaded.status,
        201,
        `${file.name}: ${JSON.stringify(body)}`,
      );
      assert.match(body.source, /^asset:[0-9a-f-]{36}$/);
      assert(!('objectKey' in body));
      const path = `/api/rooms/${owner.room.id}/assets/${body.id}`;
      const info = await call(`${path}/info`, {cookie: owner.cookie});
      assert.equal(info.status, 200);
      const asset = (await info.json()).asset;
      assert.equal(asset.id, body.id);
      assert.equal(asset.width, 2);
      assert.equal(asset.height, 2);
      assert(!('objectKey' in asset));
      const response = await call(path, {cookie: owner.cookie});
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(!bytes.includes(Buffer.from(marker)));
      if (asset.kind === 'image') {
        const metadata = await sharp(bytes, {animated: true}).metadata();
        assert(!metadata.exif);
        assert(!metadata.xmp);
        if (['gif', 'animated-webp'].includes(file.name) || file.frames) {
          assert.equal(metadata.pages, file.frames ?? 2);
          assert.equal(metadata.loop, 2);
        }
      } else {
        const range = await call(path, {
          cookie: owner.cookie,
          headers: {Range: 'bytes=0-9'},
        });
        assert.equal(range.status, 206);
        assert.equal((await range.arrayBuffer()).byteLength, 10);
        assert.match(range.headers.get('content-range'), /^bytes 0-9\//);
      }
      const head = await call(path, {method: 'HEAD', cookie: owner.cookie});
      assert.equal(head.status, 200);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await call(path, {cookie: other.cookie})).status, 401);
      assert.equal(
        (
          await call(`/api/rooms/${other.room.id}/assets/${body.id}`, {
            cookie: other.cookie,
          })
        ).status,
        404,
      );
      assets.push({
        id: body.id,
        key: `rooms/${owner.room.id}/${body.id}`,
        kind: asset.kind,
      });
    }
    assert.equal(
      (
        await upload({
          name: 'bad.svg',
          type: 'image/png',
          data: Buffer.from('<svg onload="alert(1)"></svg>'),
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await upload({
          name: 'bad.png',
          type: 'image/png',
          data: Buffer.concat([media[0].data.subarray(0, 8), Buffer.alloc(32)]),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await upload({
          name: 'large.png',
          type: 'image/png',
          data: Buffer.alloc(10 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
    const oversized = await sharp({
      create: {width: 5001, height: 5000, channels: 3, background: '#ffffff'},
    })
      .png()
      .toBuffer();
    assert.equal(
      (await upload({name: 'pixels.png', type: 'image/png', data: oversized}))
        .status,
      400,
    );
    const still = assets[0];
    const document = {
      content: `![Photo](asset:${still.id})`,
      choiceMode: 'single',
      minChoices: 1,
      maxChoices: 1,
      shareResults: false,
      publication: 'after_close',
      hideResultsUntilEnd: false,
      allowAnswerChange: false,
      anonymous: false,
      choices: [
        {content: `![A](asset:${still.id})`},
        {content: `![B](asset:${still.id})`},
      ],
    };
    const saved = await call(`/api/rooms/${owner.room.id}/questions`, {
      method: 'POST',
      cookie: owner.cookie,
      body: document,
    });
    assert.equal(saved.status, 201);
    const question = (await saved.json()).question;
    assert.equal(question.content, document.content);
    assert.equal(question.choices[0].content, document.choices[0].content);
    const foreign = await call(`/api/rooms/${other.room.id}/questions`, {
      method: 'POST',
      cookie: other.cookie,
      body: document,
    });
    assert.equal(foreign.status, 409);
    for (const content of [
      '![Remote](https://evil.test/a.png)',
      '[Bad](javascript:alert(1))',
    ])
      assert.equal(
        (
          await call(`/api/rooms/${owner.room.id}/questions`, {
            method: 'POST',
            cookie: owner.cookie,
            body: {...document, content},
          })
        ).status,
        400,
      );
    const denied = await call(`/api/rooms/${owner.room.id}/assets/keepalive`, {
      method: 'POST',
      cookie: owner.cookie,
      body: {ids: [still.id]},
      headers: {Origin: 'https://evil.test'},
    });
    assert.equal(denied.status, 403);
    // Participant access is denied until this draft is published
    const linkResponse = await call(`/api/rooms/${owner.room.id}/links`, {
      method: 'POST',
      cookie: owner.cookie,
      body: {mode: 'personal', names: ['Media participant']},
    });
    const link = (await linkResponse.json()).links[0];
    const keyResponse = await call(
      `/api/rooms/${owner.room.id}/links/${link.id}/secret`,
      {cookie: owner.cookie},
    );
    const key = (await keyResponse.json()).token;
    const joined = await call(`/api/vote/${link.id}/session`, {
      method: 'POST',
      body: {token: key},
    });
    assert.equal(joined.status, 200);
    const participantCookie = joined.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.equal(
      (
        await call(`/api/vote/${link.id}/assets/${still.id}`, {
          cookie: participantCookie,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(`/api/rooms/${owner.room.id}/assets/${still.id}`, {
          cookie: participantCookie,
        })
      ).status,
      401,
    );
    // Keep one real reference for the cleanup integration check
    await writeFile(
      '/tmp/votebox-media-test-state.json',
      JSON.stringify({
        roomId: owner.room.id,
        questionId: question.id,
        assets,
        keptId: still.id,
        linkId: link.id,
        participantCookie,
      }),
      {mode: 0o600},
    );
    console.log(
      'Media API checks passed for PNG, JPEG, WebP, AVIF, JPEG XL, GIF, animated WebP, MP4 and WebM',
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
await main();
