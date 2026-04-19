import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, isInitialized, LyError, load, save } from '../store.ts';

vi.mock('../git.ts', () => ({
  getRepoRoot: vi.fn(),
}));

import { getRepoRoot } from '../git.ts';

const mockGetRepoRoot = vi.mocked(getRepoRoot);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `ly-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, '.git', 'ly'), { recursive: true });
  mockGetRepoRoot.mockReturnValue(tmpRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── LyError ─────────────────────────────────────────────────────────────────

describe('LyError', () => {
  it('has name LyError and extends Error', () => {
    const err = new LyError('boom');
    expect(err.name).toBe('LyError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── isInitialized ───────────────────────────────────────────────────────────

describe('isInitialized', () => {
  it('returns false when meta.json does not exist', () => {
    expect(isInitialized()).toBe(false);
  });

  it('returns true when meta.json exists', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify({ trunk: 'main', branches: {} }),
    );
    expect(isInitialized()).toBe(true);
  });
});

// ─── load ────────────────────────────────────────────────────────────────────

describe('load', () => {
  it('throws LyError when not initialized', () => {
    expect(() => load()).toThrow(LyError);
  });

  it('returns parsed store when meta.json exists', () => {
    const store = { trunk: 'main', branches: { feat_a: { parent: 'main' } } };
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify(store),
    );
    expect(load()).toEqual(store);
  });
});

// ─── save ────────────────────────────────────────────────────────────────────

describe('save', () => {
  it('writes the store as pretty-printed JSON', () => {
    const store = { trunk: 'main', branches: {} };
    save(store);
    const loaded = load();
    expect(loaded).toEqual(store);
  });

  it('persists branch metadata', () => {
    const store = {
      trunk: 'main',
      branches: {
        feat_a: {
          parent: 'main',
          prNumber: 7,
          prUrl: 'https://github.com/o/r/pull/7',
        },
      },
    };
    save(store);
    expect(load()).toEqual(store);
  });
});

// ─── init ────────────────────────────────────────────────────────────────────

describe('init', () => {
  it('creates a store with the given trunk and no branches', () => {
    const store = init('main');
    expect(store).toEqual({ trunk: 'main', branches: {} });
  });

  it('persists the store so load() can read it back', () => {
    init('develop');
    expect(load()).toEqual({ trunk: 'develop', branches: {} });
  });
});
