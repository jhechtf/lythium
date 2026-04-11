import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getRepoRoot } from './git.ts';

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

export function getStorePath(): string {
  return join(getRepoRoot(), '.git', 'ly', 'meta.json');
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
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

export function init(trunk: string): LyStore {
  const store: LyStore = { trunk, branches: {} };
  save(store);
  return store;
}
