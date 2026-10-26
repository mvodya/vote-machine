import {mkdir, readFile, writeFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {getObject, putObject, listObjects} from '../lib/server/storage.mjs';
const keyPattern = /^rooms\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/;
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Reject paths outside the managed object namespace
function checkedKey(value) {
  if (typeof value !== 'string' || !keyPattern.test(value))
    throw new Error('Invalid backup key');
  return value;
}
// Copy every private object while writers and cleanup are stopped
export async function backupObjects(directory) {
  await mkdir(join(directory, 'objects'), {recursive: true, mode: 0o700});
  const objects = [];
  let cursor;
  do {
    const page = await listObjects(cursor);
    for (const entry of page.Contents ?? []) {
      const key = checkedKey(entry.Key);
      if (typeof entry.Size !== 'number' || entry.Size > 10485760)
        throw new Error('Invalid backup object size');
      const response = await getObject(key);
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      if (bytes.length > 10485760)
        throw new Error('Invalid backup object size');
      await mkdir(join(directory, 'objects', key, '..'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(directory, 'objects', key), bytes, {
        mode: 0o600,
        flag: 'wx',
      });
      objects.push({
        key,
        bytes: bytes.length,
        sha256: checksum(bytes),
        mime: response.ContentType ?? 'application/octet-stream',
      });
    }
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !cursor) throw new Error('Invalid storage page');
  } while (cursor);
  await writeFile(
    join(directory, 'objects.json'),
    JSON.stringify({version: 1, objects}),
    {mode: 0o600, flag: 'wx'},
  );
  await verifyObjects(directory);
  return objects.length;
}
// Validate every file before a restore changes the target database
export async function verifyObjects(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, 'objects.json'), 'utf8'),
  );
  if (manifest.version !== 1 || !Array.isArray(manifest.objects))
    throw new Error('Invalid object manifest');
  const seen = new Set();
  for (const item of manifest.objects) {
    const key = checkedKey(item.key);
    if (seen.has(key)) throw new Error('Duplicate backup key');
    seen.add(key);
    const path = join(directory, 'objects', key);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 10485760 || typeof item.mime !== 'string')
      throw new Error('Invalid backup object');
    const bytes = await readFile(path);
    if (bytes.length !== item.bytes || checksum(bytes) !== item.sha256)
      throw new Error('Backup checksum mismatch');
  }
  const required = JSON.parse(
    await readFile(join(directory, 'required-objects.json'), 'utf8'),
  );
  if (!Array.isArray(required)) throw new Error('Invalid required objects');
  const saved = new Map(manifest.objects.map((item) => [item.key, item]));
  for (const item of required) {
    const found = saved.get(checkedKey(item.key));
    if (!found || found.bytes !== item.bytes || found.sha256 !== item.sha256)
      throw new Error('A database object is missing from the backup');
  }
  return manifest.objects;
}
// Require a clean bucket so old untracked objects cannot survive restoration
export async function restoreObjects(directory) {
  const objects = await verifyObjects(directory);
  if ((await listObjects()).Contents?.length)
    throw new Error('Restore requires an empty object bucket');
  for (const item of objects)
    await putObject(
      item.key,
      await readFile(join(directory, 'objects', item.key)),
      item.mime,
    );
  return objects.length;
}
// The operator command prints counts only, never object keys or file data
if (import.meta.main) {
  try {
    const [action, directory] = process.argv.slice(2);
    if (!directory || !['backup', 'verify', 'restore'].includes(action))
      throw new Error('Invalid action');
    const result =
      action === 'backup'
        ? await backupObjects(directory)
        : action === 'restore'
          ? await restoreObjects(directory)
          : (await verifyObjects(directory)).length;
    console.log(JSON.stringify({service: 'backup', action, objects: result}));
  } catch {
    console.error(
      JSON.stringify({service: 'backup', event: 'object_operation_failed'}),
    );
    process.exitCode = 1;
  }
}
