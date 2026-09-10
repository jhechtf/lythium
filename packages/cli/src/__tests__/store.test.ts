import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, isInitialized, LyError, load, save } from '../store.ts';

vi.mock('../git.ts', () => ({
  gitCommonDir: vi.fn(),
}));

import { gitCommonDir } from '../git.ts';

const mockGitCommonDir = vi.mocked(gitCommonDir);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `ly-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, '.git', 'ly'), { recursive: true });
  mockGitCommonDir.mockReturnValue(join(tmpRoot, '.git'));
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

  it('throws LyError on truncated / invalid JSON instead of a SyntaxError', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      '{ "trunk": "main", "branch',
    );
    expect(() => load()).toThrow(LyError);
    expect(() => load()).toThrow(/not valid JSON/);
  });

  it('throws LyError when the JSON is well-formed but not a store', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify({ trunk: 'main' }),
    );
    expect(() => load()).toThrow(/malformed/);
  });

  it('throws LyError when a branch record is not an object', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify({ trunk: 'main', branches: { 'feat/a': null } }),
    );
    expect(() => load()).toThrow(/malformed/);
  });

  it('throws LyError when a branch record has no string parent', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify({
        trunk: 'main',
        branches: { 'feat/a': { prNumber: 3 } },
      }),
    );
    expect(() => load()).toThrow(/malformed/);
  });

  it('throws LyError when prNumber / prUrl have the wrong type', () => {
    writeFileSync(
      join(tmpRoot, '.git', 'ly', 'meta.json'),
      JSON.stringify({
        trunk: 'main',
        branches: { 'feat/a': { parent: 'main', prNumber: '3' } },
      }),
    );
    expect(() => load()).toThrow(/malformed/);
  });

  it('accepts a valid store with fully-populated branch metadata', () => {
    const store = {
      trunk: 'main',
      branches: {
        'feat/a': {
          parent: 'main',
          prNumber: 3,
          prUrl: 'https://github.com/o/r/pull/3',
        },
      },
    };
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
