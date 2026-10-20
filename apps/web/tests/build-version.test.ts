import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {buildCommit} from '../lib/server/build-version.mjs';

const folders: string[] = [];
const hash = 'abcdef0'.padEnd(40, '1');
// Keep fake revision files away from the real repository
function checkout() {
  const folder = mkdtempSync(join(tmpdir(), 'votebox-version-'));
  folders.push(folder);
  mkdirSync(join(folder, '.git', 'refs', 'heads'), {recursive: true});
  return folder;
}
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, {recursive: true, force: true})),
);

it('reads a loose branch ref without Git or repository config', () => {
  const folder = checkout();
  writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(folder, '.git', 'refs', 'heads', 'main'), `${hash}\n`);
  expect(buildCommit(folder)).toBe('abcdef0');
});
it('reads packed and detached revisions', () => {
  const folder = checkout();
  writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(
    join(folder, '.git', 'packed-refs'),
    `# packed refs\n${hash} refs/heads/main\n`,
  );
  expect(buildCommit(folder)).toBe('abcdef0');
  writeFileSync(join(folder, '.git', 'HEAD'), hash);
  expect(buildCommit(folder)).toBe('abcdef0');
});
it('follows the shared refs of a worktree', () => {
  const folder = checkout();
  const worktree = join(folder, 'tree');
  const git = join(folder, '.git', 'worktrees', 'tree');
  mkdirSync(worktree);
  mkdirSync(git, {recursive: true});
  writeFileSync(join(worktree, '.git'), `gitdir: ${git}\n`);
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(git, 'commondir'), '../..\n');
  writeFileSync(join(folder, '.git', 'refs', 'heads', 'main'), hash);
  expect(buildCommit(worktree)).toBe('abcdef0');
});
it('accepts an explicit build revision and rejects non-hash text', () => {
  const folder = checkout();
  expect(buildCommit(folder, hash.toUpperCase())).toBe('abcdef0');
  expect(buildCommit(folder, 'private-value')).toBe('dev');
  expect(buildCommit(folder)).toBe('dev');
});
