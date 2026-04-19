import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentBranch,
  GitError,
  isGitRepo,
  isMergedInto,
  listLocalBranches,
  parseOwnerRepo,
} from '../git.ts';

vi.mock('node:child_process');

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── parseOwnerRepo ───────────────────────────────────────────────────────────

describe('parseOwnerRepo', () => {
  it('parses HTTPS URL', () => {
    expect(parseOwnerRepo('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses HTTPS URL with .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses SSH URL', () => {
    expect(parseOwnerRepo('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('throws GitError for non-GitHub URLs', () => {
    expect(() => parseOwnerRepo('https://gitlab.com/owner/repo')).toThrow(
      GitError,
    );
  });

  it('throws GitError for malformed input', () => {
    expect(() => parseOwnerRepo('not-a-url')).toThrow(GitError);
  });
});

// ─── GitError ─────────────────────────────────────────────────────────────────

describe('GitError', () => {
  it('has name GitError', () => {
    const err = new GitError('oops');
    expect(err.name).toBe('GitError');
    expect(err.message).toBe('oops');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── isGitRepo ────────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  it('returns true when git rev-parse succeeds', () => {
    mockExecSync.mockReturnValue('.git\n' as unknown as Buffer);
    expect(isGitRepo()).toBe(true);
  });

  it('returns false when git rev-parse throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    expect(isGitRepo()).toBe(false);
  });
});

// ─── currentBranch ────────────────────────────────────────────────────────────

describe('currentBranch', () => {
  it('returns the trimmed branch name', () => {
    mockExecSync.mockReturnValue('main\n' as unknown as Buffer);
    expect(currentBranch()).toBe('main');
  });
});

// ─── listLocalBranches ───────────────────────────────────────────────────────

describe('listLocalBranches', () => {
  it('splits output into branch names', () => {
    mockExecSync.mockReturnValue('main\nfeat_a\nfeat_b\n' as unknown as Buffer);
    expect(listLocalBranches()).toEqual(['main', 'feat_a', 'feat_b']);
  });

  it('filters empty lines', () => {
    mockExecSync.mockReturnValue('main\n\nfeat_a\n' as unknown as Buffer);
    expect(listLocalBranches()).toEqual(['main', 'feat_a']);
  });
});

// ─── isMergedInto ─────────────────────────────────────────────────────────────

describe('isMergedInto', () => {
  it('returns true when merge-base exits 0', () => {
    mockExecSync.mockReturnValue('' as unknown as Buffer);
    expect(isMergedInto('feat_a', 'main')).toBe(true);
  });

  it('returns false when merge-base throws', () => {
    mockExecSync.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('') });
    });
    expect(isMergedInto('feat_a', 'main')).toBe(false);
  });
});
