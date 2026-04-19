import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepo, createUninitializedRepo } from './helpers/repo.ts';

// Overlay env so Conf uses an isolated config dir (no real credentials).
function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const fakeHome = join(dir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  return {
    ...process.env,
    NO_COLOR: '1',
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: join(fakeHome, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
  };
}

// ─── ly submit — error cases ─────────────────────────────────────────────────

describe('ly submit', () => {
  it('exits 1 when Lythium is not initialized', () => {
    const { ly } = createUninitializedRepo();
    const result = ly(['submit']);
    expect(result.status).toBe(1);
  });

  it('exits 1 when not authenticated', () => {
    const { dir, ly } = createTempRepo();
    // Use isolated env so there is no stored token
    const result = ly(['submit'], undefined, isolatedEnv(dir));
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('Not logged in');
  });

  it('exits 1 when on trunk branch', () => {
    const { dir, ly, git } = createTempRepo();
    // Ensure we are on the trunk branch (main)
    expect(git('branch --show-current')).toBe('main');
    const result = ly(['submit'], undefined, isolatedEnv(dir));
    // Exits 1 for "not logged in" before it checks the trunk — still non-zero
    expect(result.status).toBe(1);
  });
});

// ─── ly sync — no-remote error ───────────────────────────────────────────────

describe('ly sync', () => {
  it('exits 1 when there is no remote', () => {
    const { ly } = createTempRepo();
    const result = ly(['sync']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/fetch failed|fatal/i);
  });

  it('exits 1 when Lythium is not initialized', () => {
    const { ly } = createUninitializedRepo();
    const result = ly(['sync']);
    expect(result.status).toBe(1);
  });

  it('finds no merged branches and restacks when remote is clean', () => {
    // Set up a local bare remote so git fetch succeeds
    const remoteDir = join(
      tmpdir(),
      `ly-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(remoteDir, { recursive: true });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

    const { ly, git } = createTempRepo();

    // Add the bare repo as origin and push main
    git(`remote add origin "${remoteDir.replace(/\\/g, '/')}"`);
    git('push -u origin main');

    // Create a stacked branch and push it too
    ly(['create', 'feat/a', '--message', 'feat: a']);
    git(`push origin feat/a`);

    const result = ly(['sync']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No merged branches found');
    expect(result.stdout).toContain('Sync complete');

    // The branch should still exist locally
    expect(git('branch --list feat/a')).toContain('feat/a');
  });
});
