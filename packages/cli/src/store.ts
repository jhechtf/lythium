import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gitCommonDir } from './git.ts';

export interface BranchMeta {
  parent: string;
  prNumber?: number;
  prUrl?: string;
}

export interface LyStore {
  trunk: string;
  branches: Record<string, BranchMeta>;
}

export class LyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LyError';
  }
}

/**
 * Location of the persistent store. Anchored to the *shared* git directory
 * (`git rev-parse --git-common-dir`) rather than `<repoRoot>/.git`, so:
 *   - a bare clone works (there is no `<repoRoot>/.git`), and
 *   - every linked worktree sees the same stack metadata, instead of each
 *     worktree trying to write into its own `.git` file and failing.
 */
export function getStorePath(): string {
  return join(gitCommonDir(), 'ly', 'meta.json');
}

export function isInitialized(): boolean {
  try {
    return existsSync(getStorePath());
  } catch {
    return false;
  }
}

export function load(): LyStore {
  const path = getStorePath();
  if (!existsSync(path)) {
    throw new LyError(
      'Lythium is not initialized in this repo. Run `ly init` first.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A crash or Ctrl-C mid-write (or a botched hand-edit) can leave the file
    // truncated. Give a fixable message instead of a raw SyntaxError.
    throw new LyError(
      `Stack metadata at ${path} is not valid JSON. ` +
        'Fix it by hand or re-run `ly sync --rebuild`.',
    );
  }
  if (!isLyStore(parsed)) {
    throw new LyError(
      `Stack metadata at ${path} is malformed (missing trunk/branches).`,
    );
  }
  return parsed;
}

function isLyStore(v: unknown): v is LyStore {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<LyStore>;
  return (
    typeof s.trunk === 'string' &&
    typeof s.branches === 'object' &&
    s.branches !== null
  );
}

export function save(store: LyStore): void {
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write to a sibling temp file, then rename: a rename within a directory is
  // atomic, so an interrupted write never leaves a partial meta.json behind
  // for the next command — or another worktree sharing this store — to hit.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function init(trunk: string): LyStore {
  const store: LyStore = { trunk, branches: {} };
  save(store);
  return store;
}
