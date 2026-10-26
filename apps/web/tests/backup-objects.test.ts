import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import {verifyObjects} from '../scripts/backup-objects.mjs';

// Real files let the restore verifier check bytes before any S3 call
it('checks every backup object and refuses corruption', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'votebox-objects-'));
  try {
    await writeFile(join(folder, 'required-objects.json'), '[]');
    const key =
      'rooms/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002';
    const bytes = Buffer.from('private object');
    await mkdir(join(folder, 'objects', key, '..'), {recursive: true});
    await writeFile(join(folder, 'objects', key), bytes);
    await writeFile(
      join(folder, 'objects.json'),
      JSON.stringify({
        version: 1,
        objects: [
          {
            key,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            mime: 'image/webp',
          },
        ],
      }),
    );
    expect(await verifyObjects(folder)).toHaveLength(1);
    await writeFile(join(folder, 'objects', key), 'broken');
    await expect(verifyObjects(folder)).rejects.toThrow('checksum');
  } finally {
    await rm(folder, {recursive: true, force: true});
  }
});
it('rejects paths outside the managed object namespace', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'votebox-objects-'));
  try {
    await writeFile(
      join(folder, 'objects.json'),
      JSON.stringify({version: 1, objects: [{key: '../../private'}]}),
    );
    await expect(verifyObjects(folder)).rejects.toThrow('key');
  } finally {
    await rm(folder, {recursive: true, force: true});
  }
});
