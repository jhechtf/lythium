import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../dist/index.mjs',
);

export interface LyResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface RepoContext {
  dir: string;
  ly: (args: string[], input?: string, env?: NodeJS.ProcessEnv) => LyResult;
  git: (cmd: string) => string;
}

function makeRepo(dir: string): RepoContext {
  mkdirSync(dir, { recursive: true });

  const git = (cmd: string) =>
    execSync(`git ${cmd}`, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

  git('init');
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  git('config commit.gpgsign false');
  writeFileSync(join(dir, '.gitkeep'), '');
  git('add .gitkeep');
  git('commit --allow-empty -m "init"');
  git('branch -M main');

  const ly = (args: string[], input?: string, env?: NodeJS.ProcessEnv) => {
    const result = spawnSync('node', [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      input,
      env: env ?? { ...process.env, NO_COLOR: '1' },
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  };

  return { dir, ly, git };
}

function uniqueDir(): string {
  return join(
    tmpdir(),
    `ly-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/** Creates a temp git repo with Lythium already initialized (trunk: main). */
export function createTempRepo(): RepoContext {
  const dir = uniqueDir();
  const ctx = makeRepo(dir);

  const lyDir = join(dir, '.git', 'ly');
  mkdirSync(lyDir, { recursive: true });
  writeFileSync(
    join(lyDir, 'meta.json'),
    `${JSON.stringify({ trunk: 'main', branches: {} }, null, 2)}\n`,
  );

  return ctx;
}

/** Creates a temp git repo without Lythium initialized. */
export function createUninitializedRepo(): RepoContext {
  return makeRepo(uniqueDir());
}

export interface BareCloneContext {
  /** The bare clone directory (`<root>/bare.git`). */
  bareDir: string;
  /** Add a linked worktree checked out to `branch`; returns a RepoContext for it. */
  addWorktree: (
    name: string,
    branch: string,
    newBranch?: boolean,
  ) => RepoContext;
  /** Remove a linked worktree by the name passed to `addWorktree`. */
  removeWorktree: (name: string) => void;
}

/**
 * Creates an upstream repo, a **bare** clone of it, and returns handles for
 * attaching linked worktrees — the layout LYT-41 is about.
 */
export function createBareClone(): BareCloneContext {
  const root = uniqueDir();
  mkdirSync(root, { recursive: true });

  const run = (cmd: string, cwd: string) =>
    execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  run('init', upstream);
  run('config user.email "test@test.com"', upstream);
  run('config user.name "Test"', upstream);
  run('config commit.gpgsign false', upstream);
  writeFileSync(join(upstream, '.gitkeep'), '');
  run('add .gitkeep', upstream);
  run('commit --allow-empty -m init', upstream);
  run('branch -M main', upstream);

  const bareDir = join(root, 'bare.git');
  run(`clone --bare "${upstream}" "${bareDir}"`, root);
  run('config commit.gpgsign false', bareDir);
  run('config user.email "test@test.com"', bareDir);
  run('config user.name "Test"', bareDir);
  // `clone --bare` leaves no fetch refspec, so `git fetch` never populates
  // `refs/remotes/origin/*`. A bare clone used as a dev checkout needs one.
  run(
    'config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
    bareDir,
  );
  run('fetch origin', bareDir);

  const worktrees = new Map<string, string>();

  const addWorktree = (name: string, branch: string, newBranch = false) => {
    const dir = join(root, name);
    run(
      `worktree add ${newBranch ? `-b ${branch} ` : ''}"${dir}" ${newBranch ? 'main' : branch}`,
      bareDir,
    );
    worktrees.set(name, dir);

    const git = (cmd: string) =>
      execSync(`git ${cmd}`, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const ly = (args: string[], input?: string, env?: NodeJS.ProcessEnv) => {
      const result = spawnSync('node', [CLI, ...args], {
        cwd: dir,
        encoding: 'utf8',
        input,
        env: env ?? { ...process.env, NO_COLOR: '1' },
      });
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status,
      };
    };
    return { dir, ly, git };
  };

  const removeWorktree = (name: string) => {
    const dir = worktrees.get(name);
    if (dir) run(`worktree remove --force "${dir}"`, bareDir);
    worktrees.delete(name);
  };

  return { bareDir, addWorktree, removeWorktree };
}
