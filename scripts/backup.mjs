import {execFileSync, spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  realpath,
} from 'node:fs/promises';
import {resolve, join, isAbsolute, sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createHash, randomUUID} from 'node:crypto';

// Keep commands scoped to the operator-selected Compose project
const project = process.env.COMPOSE_PROJECT_NAME ?? 'vote-machine';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project))
  throw new Error('Invalid project');
function compose(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
}
// A mounted development workspace could still write during a snapshot
function hasWorkspace() {
  return (
    execFileSync(
      'docker',
      [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=workspace',
      ],
      {encoding: 'utf8', timeout: 10000},
    ).trim().length > 0
  );
}
// Stream large dumps without holding them in memory
async function dumpTo(path) {
  const child = spawn(
    'docker',
    [
      'compose',
      '-p',
      project,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'vote_machine',
      '-d',
      'vote_machine',
      '-Fc',
      '--no-owner',
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  child.stderr.resume();
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Database dump failed')),
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(path, {mode: 0o600, flags: 'wx'})),
    exit,
  ]);
}
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// Use a one-off web image with existing S3 settings and no published ports
function objects(action, folder) {
  return compose(
    'run',
    '--rm',
    '--no-deps',
    '--user',
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-v',
    `${folder}:/backup`,
    'web',
    'node',
    'apps/web/scripts/backup-objects.mjs',
    action,
    '/backup',
  );
}
// Copy database and objects while every application writer is stopped
export async function backup(root) {
  if (!isAbsolute(root)) throw new Error('Backup directory must be absolute');
  root = resolve(root);
  await mkdir(root, {recursive: true, mode: 0o700});
  const actualRoot = await realpath(root);
  const workspace = resolve(import.meta.dirname, '..');
  if (
    actualRoot === workspace ||
    actualRoot.startsWith(workspace + sep) ||
    ((await stat(actualRoot)).mode & 0o077) !== 0
  )
    throw new Error('Use a private backup directory outside the workspace');
  const lock = join(root, '.backup-lock');
  await mkdir(lock, {mode: 0o700});
  let running = [];
  let stopped = false;
  try {
    if (hasWorkspace())
      throw new Error('Stop the development workspace before backup');
    running = compose('ps', '-q', 'web', 'api', 'asset-cleanup')
      .split('\n')
      .filter(Boolean);
    if (!running.length) throw new Error('No running application to back up');
    const folder = join(
      root,
      new Date().toISOString().replace(/[:.]/g, '-') +
        '-' +
        randomUUID().slice(0, 8),
    );
    await mkdir(folder, {mode: 0o700});
    stopped = true;
    compose('stop', '--timeout', '20', 'asset-cleanup', 'web', 'api');
    await dumpTo(join(folder, 'database.dump'));
    const required = compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'vote_machine',
      '-d',
      'vote_machine',
      '-Atc',
      "SELECT COALESCE(jsonb_agg(jsonb_build_object('key','rooms/'||room_id::text||'/'||id::text,'sha256',encode(sha256,'hex'),'bytes',bytes)),'[]') FROM assets WHERE state='ready'",
    );
    await writeFile(join(folder, 'required-objects.json'), required, {
      mode: 0o600,
      flag: 'wx',
    });
    objects('backup', folder);
    await writeFile(
      join(folder, 'complete.json'),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        databaseSha256: await fileHash(join(folder, 'database.dump')),
      }),
      {mode: 0o600, flag: 'wx'},
    );
    // Prune only our completed snapshots after the agreed thirty days
    for (const name of await readdir(root)) {
      if (!/^\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{8}$/.test(name)) continue;
      try {
        const manifest = JSON.parse(
          await readFile(join(root, name, 'complete.json'), 'utf8'),
        );
        if (
          manifest.version === 1 &&
          Date.now() - Date.parse(manifest.createdAt) > 30 * 86400000
        )
          await rm(join(root, name), {recursive: true});
      } catch {}
    }
    return folder;
  } finally {
    if (stopped && running.length)
      execFileSync('docker', ['start', ...running], {
        stdio: 'ignore',
        timeout: 60000,
      });
    await rm(lock, {recursive: true, force: true});
  }
}
// Restores are explicit and must target an empty, dedicated object bucket
export async function restore(folder, confirmed) {
  if (!confirmed || !isAbsolute(folder))
    throw new Error('Confirm data replacement with --confirm-replace-data');
  const manifest = JSON.parse(
    await readFile(join(folder, 'complete.json'), 'utf8'),
  );
  if (
    manifest.version !== 1 ||
    (await fileHash(join(folder, 'database.dump'))) !== manifest.databaseSha256
  )
    throw new Error('Database checksum mismatch');
  objects('verify', folder);
  if (hasWorkspace())
    throw new Error('Stop the development workspace before restore');
  // All file checks run before the target database is touched
  compose('stop', '--timeout', '20', 'asset-cleanup', 'web', 'api');
  objects('restore', folder);
  compose(
    'exec',
    '-T',
    'postgres',
    'dropdb',
    '-U',
    'vote_machine',
    '--force',
    '--if-exists',
    'vote_machine',
  );
  compose(
    'exec',
    '-T',
    'postgres',
    'createdb',
    '-U',
    'vote_machine',
    'vote_machine',
  );
  const child = spawn(
    'docker',
    [
      'compose',
      '-p',
      project,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'vote_machine',
      '-d',
      'vote_machine',
      '--no-owner',
      '--exit-on-error',
    ],
    {stdio: ['pipe', 'ignore', 'pipe']},
  );
  child.stderr.resume();
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Database restore failed')),
    );
  });
  await Promise.all([
    pipeline(createReadStream(join(folder, 'database.dump')), child.stdin),
    exit,
  ]);
  compose(
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '120',
    'api',
    'web',
    'asset-cleanup',
  );
}
if (import.meta.main) {
  try {
    const [action, folder, confirm] = process.argv.slice(2);
    if (action === 'backup') await backup(folder ?? '');
    else if (action === 'restore')
      await restore(folder ?? '', confirm === '--confirm-replace-data');
    else throw new Error('Use backup or restore');
    console.log(
      JSON.stringify({service: 'backup', action, status: 'complete'}),
    );
  } catch {
    console.error(
      JSON.stringify({service: 'backup', event: 'operation_failed'}),
    );
    process.exitCode = 1;
  }
}
