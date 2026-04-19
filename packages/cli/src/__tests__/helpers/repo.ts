import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../../../dist/index.mjs');

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
