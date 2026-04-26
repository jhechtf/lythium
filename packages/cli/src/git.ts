import { execSync } from 'node:child_process';

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
    const err = e as { stderr?: Buffer; message: string };
    throw new GitError(err.stderr?.toString().trim() || err.message);
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

export function currentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD');
}

export function listLocalBranches(): string[] {
  const out = git('branch --format=%(refname:short)');
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
  git('fetch origin');
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
