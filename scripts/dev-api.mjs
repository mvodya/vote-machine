import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

let child;
let stopping = false;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function stopChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const current = child;
  return new Promise((resolve) => {
    const timer = setTimeout(() => killGroup(current.pid, 'SIGKILL'), 3000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    killGroup(current.pid, 'SIGTERM');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    void stopChild();
  });
}

async function snapshot(directory) {
  const hash = createHash('sha256');
  async function visit(path) {
    const entries = await readdir(path, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile()) {
        hash.update(name);
        hash.update(await readFile(name));
      }
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

function start(command, args, options = {}) {
  child = spawn(command, args, {stdio: 'inherit', detached: true, ...options});
  child.on('error', (error) => console.error(error.message));
  return new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

let previous;
try {
  while (!stopping) {
    let current;
    try {
      current = await snapshot('apps/api');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(500);
      continue;
    }
    if (current !== previous) {
      previous = current;
      await stopChild();
      if (stopping) break;
      console.log('Building API');
      const configured = await start('cmake', ['--preset', 'dev'], {
        cwd: 'apps/api',
      });
      if (stopping) break;
      const built =
        configured &&
        (await start(
          'cmake',
          ['--build', '--preset', 'dev', '--parallel', '2'],
          {cwd: 'apps/api'},
        ));
      if (stopping) break;
      if (built) {
        console.log('Starting API');
        void start('./build/api/vote_machine_api', []);
      } else {
        console.error('API build failed, waiting for changes');
      }
    }
    await delay(500);
  }
} finally {
  await stopChild();
}
