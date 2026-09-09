import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../git.ts';
import { LyError } from '../store.ts';
import {
  assertBranchesAvailable,
  branchCheckedOutElsewhere,
  describeWorktreeLayout,
  worktreeForBranch,
} from '../worktree.ts';

const { mockListWorktrees, mockGetRepoRoot, mockIsBareRepo } = vi.hoisted(
  () => ({
    mockListWorktrees: vi.fn<() => Worktree[]>(),
    mockGetRepoRoot: vi.fn<() => string>(),
    mockIsBareRepo: vi.fn<() => boolean>(),
  }),
);

vi.mock('../git.ts', () => ({
  listWorktrees: mockListWorktrees,
  getRepoRoot: mockGetRepoRoot,
  isBareRepo: mockIsBareRepo,
}));

const wt = (partial: Partial<Worktree> & { path: string }): Worktree => ({
  bare: false,
  detached: false,
  ...partial,
});

beforeEach(() => {
  mockListWorktrees.mockReset();
  mockGetRepoRoot.mockReset();
  mockIsBareRepo.mockReset();
  mockGetRepoRoot.mockReturnValue('/repo/main');
  mockIsBareRepo.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worktreeForBranch', () => {
  it('finds the worktree holding a branch', () => {
    const trees = [
      wt({ path: '/repo/main', branch: 'main' }),
      wt({ path: '/repo/feat', branch: 'feat/x' }),
    ];
    expect(worktreeForBranch('feat/x', trees)?.path).toBe('/repo/feat');
  });

  it('returns undefined when no worktree has the branch', () => {
    expect(
      worktreeForBranch('nope', [wt({ path: '/repo/main', branch: 'main' })]),
    ).toBeUndefined();
  });
});

describe('branchCheckedOutElsewhere', () => {
  beforeEach(() => {
    mockListWorktrees.mockReturnValue([
      wt({ path: '/repo/main', branch: 'main' }),
      wt({ path: '/repo/feat', branch: 'feat/x' }),
    ]);
  });

  it('returns the other worktree path when the branch is checked out there', () => {
    expect(branchCheckedOutElsewhere('feat/x')).toBe('/repo/feat');
  });

  it('returns undefined for a branch checked out in the current worktree', () => {
    expect(branchCheckedOutElsewhere('main')).toBeUndefined();
  });

  it('returns undefined for a branch checked out nowhere', () => {
    expect(branchCheckedOutElsewhere('feat/y')).toBeUndefined();
  });

  it('returns undefined when there is no working tree (bare)', () => {
    mockGetRepoRoot.mockImplementation(() => {
      throw new Error('this operation must be run in a work tree');
    });
    expect(branchCheckedOutElsewhere('feat/x')).toBeUndefined();
  });
});

describe('assertBranchesAvailable', () => {
  it('does not throw when every branch is free or local', () => {
    mockListWorktrees.mockReturnValue([
      wt({ path: '/repo/main', branch: 'main' }),
    ]);
    expect(() =>
      assertBranchesAvailable(['feat/a', 'feat/b', 'main']),
    ).not.toThrow();
  });

  it('throws LyError naming each branch checked out elsewhere', () => {
    mockListWorktrees.mockReturnValue([
      wt({ path: '/repo/main', branch: 'main' }),
      wt({ path: '/repo/a', branch: 'feat/a' }),
      wt({ path: '/repo/b', branch: 'feat/b' }),
    ]);

    try {
      assertBranchesAvailable(['feat/a', 'feat/b', 'feat/c']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LyError);
      expect((e as LyError).message).toContain('feat/a');
      expect((e as LyError).message).toContain('/repo/a');
      expect((e as LyError).message).toContain('feat/b');
      expect((e as LyError).message).not.toContain('feat/c');
    }
  });
});

describe('describeWorktreeLayout', () => {
  it('flags a bare clone with multiple worktrees', () => {
    mockListWorktrees.mockReturnValue([
      wt({ path: '/repo/bare', bare: true }),
      wt({ path: '/repo/main', branch: 'main' }),
      wt({ path: '/repo/feat', branch: 'feat/x' }),
    ]);

    expect(describeWorktreeLayout()).toEqual({
      bare: true,
      worktreeCount: 2,
      bareWithMultipleWorktrees: true,
    });
  });

  it('reports a plain single-worktree repo', () => {
    mockListWorktrees.mockReturnValue([wt({ path: '/repo', branch: 'main' })]);

    expect(describeWorktreeLayout()).toEqual({
      bare: false,
      worktreeCount: 1,
      bareWithMultipleWorktrees: false,
    });
  });
});
