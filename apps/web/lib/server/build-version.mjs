import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Return only a short public revision, never other Git data
export function buildCommit(directory, revision) {
  if (/^[a-f0-9]{7,40}$/i.test(revision ?? ''))
    return revision.slice(0, 7).toLowerCase();
  try {
    let git = resolve(directory, '.git');
    try {
      const pointer = readFileSync(git, 'utf8').trim();
      if (pointer.startsWith('gitdir: '))
        git = resolve(directory, pointer.slice(8));
    } catch {}
    const head = readFileSync(resolve(git, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40}$/i.test(head)) return head.slice(0, 7).toLowerCase();
    if (!head.startsWith('ref: refs/')) return 'dev';
    const ref = head.slice(5);
    // Worktrees may share their refs with the main checkout
    let shared = git;
    try {
      shared = resolve(
        git,
        readFileSync(resolve(git, 'commondir'), 'utf8').trim(),
      );
    } catch {}
    for (const base of [git, shared]) {
      try {
        const hash = readFileSync(resolve(base, ref), 'utf8').trim();
        if (/^[a-f0-9]{40}$/i.test(hash)) return hash.slice(0, 7).toLowerCase();
      } catch {}
      try {
        for (const line of readFileSync(
          resolve(base, 'packed-refs'),
          'utf8',
        ).split('\n')) {
          const [hash, name] = line.split(' ');
          if (name === ref && /^[a-f0-9]{40}$/i.test(hash))
            return hash.slice(0, 7).toLowerCase();
        }
      } catch {}
    }
  } catch {}
  // Source archives can supply GIT_COMMIT without a Git checkout
  return 'dev';
}
