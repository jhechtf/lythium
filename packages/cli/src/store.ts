import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  return JSON.parse(readFileSync(path, 'utf8')) as LyStore;
}

export function save(store: LyStore): void {
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function init(trunk: string): LyStore {
  const store: LyStore = { trunk, branches: {} };
  save(store);
  return store;
}
