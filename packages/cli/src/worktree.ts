import { relative } from 'node:path';
import pc from 'picocolors';
import {
  getRepoRoot,
  isBareRepo,
  listWorktrees,
  type Worktree,
} from './git.ts';
import { LyError } from './store.ts';

/** Do `a` and `b` point at the same directory? (case/separator tolerant). */
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/** The worktree that currently has `branch` checked out, if any. */
export function worktreeForBranch(
  branch: string,
  worktrees: Worktree[] = listWorktrees(),
): Worktree | undefined {
  return worktrees.find((w) => w.branch === branch);
}

/**
 * If `branch` is checked out in a worktree *other than the one we're running in*,
 * return that worktree's path. Otherwise `undefined`.
 *
 * git refuses to check out or rebase a branch that is active in another
 * worktree; catching it here lets commands fail before mutating anything.
 */
export function branchCheckedOutElsewhere(
  branch: string,
  worktrees: Worktree[] = listWorktrees(),
): string | undefined {
  const hit = worktreeForBranch(branch, worktrees);
  if (!hit) return undefined;

  let here: string;
  try {
    here = getRepoRoot();
  } catch {
    // No working tree (running from the bare dir): nothing is checked out
    // *here*, so any worktree holding the branch is by definition elsewhere.
    return hit.path;
  }

  return samePath(hit.path, here) ? undefined : hit.path;
}

/**
 * Throw `LyError` if any of `branches` is checked out in another worktree.
 * Call this before a command starts checking out / rebasing a set of branches,
 * so a shared branch can't leave the stack half-restacked.
 *
 * Pass `trunk` so a conflict on trunk itself gets advice that fits the bare
 * layout — trunk's worktree is permanent, so "remove that worktree" is wrong.
 */
export function assertBranchesAvailable(
  branches: Iterable<string>,
  trunk?: string,
): void {
  const worktrees = listWorktrees();
  const conflicts: string[] = [];
  let trunkConflict = false;

  for (const branch of new Set(branches)) {
    const other = branchCheckedOutElsewhere(branch, worktrees);
    if (!other) continue;
    if (branch === trunk) {
      trunkConflict = true;
      conflicts.push(`  ${branch} (trunk) — checked out at ${other}`);
    } else {
      conflicts.push(`  ${branch} — checked out at ${other}`);
    }
  }

  if (conflicts.length === 0) return;

  const advice = trunkConflict
    ? 'cd into that worktree to work on trunk, or choose a different branch.'
    : 'Switch away from or remove that worktree, then re-run.';
  throw new LyError(
    `${conflicts.length === 1 ? 'A branch is' : 'Branches are'} checked out in ` +
      `another worktree and cannot be moved:\n${conflicts.join('\n')}\n${advice}`,
  );
}

/**
 * `assertBranchesAvailable`, but prints the error in red and exits non-zero
 * instead of throwing — matches how the branch-mutating commands report failures.
 */
export function guardBranchesAvailable(
  branches: Iterable<string>,
  trunk?: string,
): void {
  try {
    assertBranchesAvailable(branches, trunk);
  } catch (e) {
    console.error(pc.red(e instanceof LyError ? e.message : String(e)));
    process.exit(1);
  }
}

export interface WorktreeLayout {
  /** The repo is (or is backed by) a bare clone. */
  bare: boolean;
  /** Number of real (non-bare) worktrees attached. */
  worktreeCount: number;
  /** A bare clone with more than one worktree attached. */
  bareWithMultipleWorktrees: boolean;
}

/**
 * Describe the worktree layout so commands can decide whether to warn. A bare
 * clone with several worktrees is the configuration most likely to surprise the
 * assumptions the CLI makes about a single working directory.
 */
export function describeWorktreeLayout(): WorktreeLayout {
  const worktrees = listWorktrees();
  const bare = isBareRepo() || worktrees.some((w) => w.bare);
  const worktreeCount = worktrees.filter((w) => !w.bare).length;
  return {
    bare,
    worktreeCount,
    bareWithMultipleWorktrees: bare && worktreeCount > 1,
  };
}
