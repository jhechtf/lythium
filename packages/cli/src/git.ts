import { execFileSync, execSync } from 'node:child_process';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

let debugMode = false;

export function setDebug(value: boolean): void {
  debugMode = value;
}

function wrapGitError(e: unknown): never {
  const err = e as { stderr?: Buffer; message: string };
  throw new GitError(err.stderr?.toString().trim() || err.message);
}

function git(cmd: string): string {
  if (debugMode) {
    process.stderr.write(`[git] git ${cmd}\n`);
  }
  try {
    return execSync(`git ${cmd}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    wrapGitError(e);
  }
}

/**
 * Run git with an explicit argument array, avoiding shell interpolation.
 * Use this whenever an argument is not a trusted, validated git ref.
 */
function gitArgs(args: string[]): string {
  if (debugMode) {
    process.stderr.write(`[git] git ${args.join(' ')}\n`);
  }
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    wrapGitError(e);
  }
}

export function isGitRepo(): boolean {
  try {
    git('rev-parse --git-dir');
    return true;
  } catch {
    return false;
  }
}

export function getRepoRoot(): string {
  return git('rev-parse --show-toplevel');
}

/** True when the current git directory is a bare repository (no working tree). */
export function isBareRepo(): boolean {
  try {
    return git('rev-parse --is-bare-repository') === 'true';
  } catch {
    return false;
  }
}

/**
 * Absolute path to the *shared* git directory. For a linked worktree this is the
 * main repo's `.git` (or the bare repo itself), not the worktree's private
 * `.git/worktrees/<name>` directory — so state stored here is visible from every
 * worktree attached to the same repo.
 */
export function gitCommonDir(): string {
  return git('rev-parse --path-format=absolute --git-common-dir');
}

export interface Worktree {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Commit checked out here; absent for the bare entry. */
  head?: string;
  /** Short branch name checked out here; absent when detached or bare. */
  branch?: string;
  /** True for the repository's bare entry (it has no working tree). */
  bare: boolean;
  /** True when this worktree's HEAD is detached. */
  detached: boolean;
}

/** Every worktree attached to this repo, parsed from `git worktree list --porcelain`. */
export function listWorktrees(): Worktree[] {
  const out = gitArgs(['worktree', 'list', '--porcelain']);
  const trees: Worktree[] = [];
  let current: Partial<Worktree> | null = null;

  const flush = () => {
    if (current?.path) {
      trees.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
    }
    current = null;
  };

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (!current) {
      // Attribute line with no preceding `worktree` line — ignore.
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .replace(/^refs\/heads\//, '');
    }
  }
  flush();

  return trees;
}

export function currentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD');
}

export function listLocalBranches(): string[] {
  // execFile (no shell): the `%(refname:short)` format string contains parens
  // that POSIX shells like dash choke on when this runs through `sh -c`.
  const out = gitArgs(['branch', '--format=%(refname:short)']);
  return out.split('\n').filter(Boolean);
}

export function commitHash(branch: string): string {
  return git(`rev-parse ${branch}`);
}

export function createBranch(name: string, base: string): void {
  git(`checkout -b ${name} ${base}`);
}

export function checkout(branch: string): void {
  git(`checkout ${branch}`);
}

export function stageAll(): void {
  git('add -A');
}

export function hasStagedChanges(): boolean {
  try {
    git('diff --cached --quiet');
    return false;
  } catch {
    return true;
  }
}

export function hasWorkingChanges(): boolean {
  try {
    git('diff --quiet');
    return false;
  } catch {
    return true;
  }
}

export function commit(message: string): void {
  git(`commit -m ${JSON.stringify(message)}`);
}

export function commitEmpty(message: string): void {
  git(`commit --allow-empty -m ${JSON.stringify(message)}`);
}

export function amendCommit(message?: string): void {
  if (message) {
    git(`commit --amend -m ${JSON.stringify(message)}`);
  } else {
    git('commit --amend --no-edit');
  }
}

export function rebase(onto: string): void {
  git(`rebase ${onto}`);
}

/** Checkout `branch`, rebase it onto `onto`, then return to `returnTo`. */
export function forceRebase(
  branch: string,
  onto: string,
  returnTo: string,
): void {
  checkout(branch);
  try {
    git(`rebase ${onto}`);
  } finally {
    // Return to original branch even if rebase fails
    try {
      checkout(returnTo);
    } catch {
      /* ignore */
    }
  }
}

export function push(branch: string, force = false): void {
  const flag = force ? ' --force-with-lease' : '';
  git(`push origin ${branch}${flag}`);
}

export function fetch(): void {
  git('fetch origin --prune');
}

/**
 * Fast-forward the local trunk branch to match `origin/<trunk>`.
 * Works whether or not trunk is the currently checked-out branch.
 */
export function updateTrunk(trunk: string): void {
  if (currentBranch() === trunk) {
    gitArgs(['merge', '--ff-only', `origin/${trunk}`]);
  } else {
    // Only fast-forward: refuse to move trunk backward over local-only commits.
    gitArgs(['merge-base', '--is-ancestor', trunk, `origin/${trunk}`]);
    gitArgs(['branch', '-f', trunk, `origin/${trunk}`]);
  }
}

export function isMergedInto(branch: string, target: string): boolean {
  try {
    git(`merge-base --is-ancestor ${branch} ${target}`);
    return true;
  } catch {
    return false;
  }
}

export function deleteBranch(branch: string, force = false): void {
  git(`branch ${force ? '-D' : '-d'} ${branch}`);
}

export function trackRemoteBranch(branch: string): void {
  git(`branch --track ${branch} origin/${branch}`);
}

export function getRemoteUrl(): string {
  return git('remote get-url origin');
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(\.git)?/);
  if (!match) throw new GitError(`Cannot parse GitHub remote URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}
