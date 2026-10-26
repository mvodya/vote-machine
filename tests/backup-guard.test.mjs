import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {backup} from '../scripts/backup.mjs';

// Invalid destinations must fail before any Docker operation or permission change
test('backup rejects public directories and the repository without changing permissions', async () => {
  for (const folder of ['/tmp', process.cwd()]) {
    const before = (await stat(folder)).mode;
    await assert.rejects(backup(folder));
    assert.equal((await stat(folder)).mode, before);
  }
  await assert.rejects(backup('relative/path'));
});
