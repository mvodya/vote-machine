import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';

test('launchpad hook accepts only main fast forwards and blocks deletion', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'votemachine-hook-'));
  const hook = resolve('deploy/launchpad/pre-receive');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  // Use isolated Git objects without touching the project history
  function git(args, input = '') {
    return execFileSync('git', args, {
      cwd: directory,
      env,
      input,
      encoding: 'utf8',
    }).trim();
  }
  // Feed the same records Git sends to the server hook
  function accepts(old, next, ref = 'refs/heads/main') {
    return (
      spawnSync('sh', [hook], {
        cwd: directory,
        env,
        input: `${old} ${next} ${ref}\n`,
      }).status === 0
    );
  }
  try {
    git(['init', '--bare', '--initial-branch=main']);
    const tree = git(['mktree']);
    const first = git(['commit-tree', tree], 'First test release\n');
    const next = git(['commit-tree', tree, '-p', first], 'Next test release\n');
    const empty = '0'.repeat(40);
    assert.equal(accepts(empty, first), true);
    assert.equal(accepts(first, next), true);
    assert.equal(accepts(next, first), false);
    assert.equal(accepts(first, empty), false);
    assert.equal(accepts(empty, first, 'refs/heads/test'), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
