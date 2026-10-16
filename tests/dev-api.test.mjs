import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';

const script = fileURLToPath(
  new URL('../scripts/dev-api.mjs', import.meta.url),
);

async function waitFor(check, output) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(`Timed out waiting for watcher\n${output()}`);
}

test(
  'API watcher rebuilds, recovers from failures and stops its child',
  {timeout: 60000},
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vote-machine-watch-'));
    const api = join(directory, 'apps/api');
    await mkdir(api, {recursive: true});
    const cmake = `cmake_minimum_required(VERSION 3.25)
project(watch_test LANGUAGES CXX)
add_executable(vote_machine_api main.cpp)
`;
    await writeFile(join(api, 'CMakeLists.txt'), cmake);
    await writeFile(
      join(api, 'CMakePresets.json'),
      JSON.stringify({
        version: 3,
        configurePresets: [
          {
            name: 'dev',
            generator: 'Ninja',
            binaryDir: '${sourceDir}/../../build/api',
          },
        ],
        buildPresets: [{name: 'dev', configurePreset: 'dev'}],
      }),
    );
    await writeFile(
      join(api, 'main.cpp'),
      `#include <fstream>
#include <unistd.h>
#include "value.hpp"
int main() {
  std::ofstream("runtime.txt") << VALUE << " " << getpid();
  for (;;) pause();
}
`,
    );
    const value = join(api, 'value.hpp');
    await writeFile(value, '#define VALUE "first"\n');
    let output = '';
    const watcher = spawn(process.execPath, [script], {cwd: directory});
    watcher.stdout.on('data', (chunk) => {
      output += chunk;
    });
    watcher.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = once(watcher, 'exit');
    let pid;
    async function running(version) {
      try {
        const [actual, processId] = (
          await readFile(join(directory, 'runtime.txt'), 'utf8')
        ).split(' ');
        if (actual !== version) return false;
        process.kill(Number(processId), 0);
        pid = Number(processId);
        return true;
      } catch {
        return false;
      }
    }
    function stopped(processId) {
      try {
        process.kill(processId, 0);
        return false;
      } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    }
    try {
      await waitFor(
        () => running('first'),
        () => output,
      );
      const firstPid = pid;
      await writeFile(value, '#define VALUE "second"\n');
      await waitFor(
        () => running('second'),
        () => output,
      );
      assert.ok(stopped(firstPid));
      const secondPid = pid;
      await writeFile(value, 'invalid C++\n');
      await waitFor(
        () => output.includes('API build failed'),
        () => output,
      );
      assert.ok(stopped(secondPid));
      await writeFile(value, '#define VALUE "recovered"\n');
      await waitFor(
        () => running('recovered'),
        () => output,
      );
      const recoveredPid = pid;
      output = '';
      await rm(value);
      await waitFor(
        () => output.includes('API build failed'),
        () => output,
      );
      assert.ok(stopped(recoveredPid));
      await writeFile(value, '#define VALUE "added"\n');
      await waitFor(
        () => running('added'),
        () => output,
      );
      output = '';
      await writeFile(join(api, 'CMakeLists.txt'), 'invalid cmake syntax (\n');
      await waitFor(
        () => output.includes('API build failed'),
        () => output,
      );
      await writeFile(join(api, 'CMakeLists.txt'), cmake);
      await waitFor(
        () => running('added'),
        () => output,
      );
      const apiPid = pid;
      await writeFile(
        join(api, 'CMakeLists.txt'),
        cmake +
          `execute_process(COMMAND sh -c "echo $$ > configure.pid; exec sleep 30")\n`,
      );
      let configurePid;
      await waitFor(
        async () => {
          try {
            configurePid = Number(
              await readFile(join(api, 'configure.pid'), 'utf8'),
            );
            return configurePid > 0;
          } catch {
            return false;
          }
        },
        () => output,
      );
      watcher.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0);
      assert.ok(stopped(apiPid));
      await waitFor(
        () => stopped(configurePid),
        () => output,
      );
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) {
        watcher.kill('SIGTERM');
        await exited;
      }
      await rm(directory, {recursive: true, force: true});
    }
  },
);
