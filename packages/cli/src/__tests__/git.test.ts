import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentBranch,
  GitError,
  isBareRepo,
  isGitRepo,
  isMergedInto,
  listLocalBranches,
  listWorktrees,
  parseOwnerRepo,
  updateTrunk,
} from '../git.ts';

const { mockExecSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn<() => string>(),
  mockExecFileSync: vi.fn<() => string>(),
}));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

beforeEach(() => {
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
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
    mockExecSync.mockReturnValue('.git\n');
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
    mockExecSync.mockReturnValue('main\n');
    expect(currentBranch()).toBe('main');
  });
});

// ─── updateTrunk ─────────────────────────────────────────────────────────────

describe('updateTrunk', () => {
  it('ff-merges in place when trunk is the current branch', () => {
    mockExecSync.mockReturnValue('main\n'); // currentBranch()
    mockExecFileSync.mockReturnValue('');
    updateTrunk('main');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['merge', '--ff-only', 'origin/main'],
      expect.anything(),
    );
  });

  it('moves the ref with branch -f when trunk is checked out nowhere', () => {
    mockExecSync.mockReturnValue('feat/x\n');
    mockExecFileSync.mockReturnValue('');
    updateTrunk('main');
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['merge-base', '--is-ancestor', 'main', 'origin/main'],
      expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['branch', '-f', 'main', 'origin/main'],
      expect.anything(),
    );
  });

  it('ff-merges inside the holding worktree when trunk lives elsewhere', () => {
    mockExecSync.mockReturnValue('feat/x\n');
    mockExecFileSync.mockReturnValue('');
    updateTrunk('main', '/repo/main');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/main', 'merge', '--ff-only', 'origin/main'],
      expect.anything(),
    );
  });
});

// ─── listLocalBranches ───────────────────────────────────────────────────────

describe('listLocalBranches', () => {
  it('splits output into branch names', () => {
    mockExecFileSync.mockReturnValue('main\nfeat_a\nfeat_b\n');
    expect(listLocalBranches()).toEqual(['main', 'feat_a', 'feat_b']);
  });

  it('filters empty lines', () => {
    mockExecFileSync.mockReturnValue('main\n\nfeat_a\n');
    expect(listLocalBranches()).toEqual(['main', 'feat_a']);
  });
});

// ─── isBareRepo ───────────────────────────────────────────────────────────────

describe('isBareRepo', () => {
  it('returns true when rev-parse prints "true"', () => {
    mockExecSync.mockReturnValue('true\n');
    expect(isBareRepo()).toBe(true);
  });

  it('returns false when rev-parse prints "false"', () => {
    mockExecSync.mockReturnValue('false\n');
    expect(isBareRepo()).toBe(false);
  });

  it('returns false when rev-parse throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    expect(isBareRepo()).toBe(false);
  });
});

// ─── listWorktrees ────────────────────────────────────────────────────────────

describe('listWorktrees', () => {
  it('parses porcelain output into worktree records', () => {
    mockExecFileSync.mockReturnValue(
      [
        'worktree /repo/bare',
        'bare',
        '',
        'worktree /repo/main',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /repo/feature',
        'HEAD def456',
        'branch refs/heads/feat/x',
        '',
        'worktree /repo/detached',
        'HEAD 789aaa',
        'detached',
        '',
      ].join('\0'),
    );

    expect(listWorktrees()).toEqual([
      { path: '/repo/bare', bare: true, detached: false },
      {
        path: '/repo/main',
        head: 'abc123',
        branch: 'main',
        bare: false,
        detached: false,
      },
      {
        path: '/repo/feature',
        head: 'def456',
        branch: 'feat/x',
        bare: false,
        detached: false,
      },
      {
        path: '/repo/detached',
        head: '789aaa',
        bare: false,
        detached: true,
      },
    ]);
  });

  it('returns a single record for a plain repo', () => {
    mockExecFileSync.mockReturnValue(
      'worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0',
    );
    expect(listWorktrees()).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'main',
        bare: false,
        detached: false,
      },
    ]);
  });

  it('keeps a worktree path that contains a newline intact', () => {
    mockExecFileSync.mockReturnValue(
      'worktree /repo/wt\nwith-newline\0HEAD abc123\0branch refs/heads/main\0\0',
    );
    expect(listWorktrees()).toEqual([
      {
        path: '/repo/wt\nwith-newline',
        head: 'abc123',
        branch: 'main',
        bare: false,
        detached: false,
      },
    ]);
  });
});

// ─── isMergedInto ─────────────────────────────────────────────────────────────

describe('isMergedInto', () => {
  it('returns true when merge-base exits 0', () => {
    mockExecSync.mockReturnValue('');
    expect(isMergedInto('feat_a', 'main')).toBe(true);
  });

  it('returns false when merge-base throws', () => {
    mockExecSync.mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('') });
    });
    expect(isMergedInto('feat_a', 'main')).toBe(false);
  });
});
