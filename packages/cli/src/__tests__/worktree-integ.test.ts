import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBareClone } from './helpers/repo.ts';

describe('bare clone + multiple worktrees', () => {
  it(
    'shares one store across worktrees and reports the layout on init',
    { timeout: 30_000 },
    () => {
      const repo = createBareClone();
      const main = repo.addWorktree('main', 'main');
      const other = repo.addWorktree('other', 'other', true);

      const init = main.ly(['init', '--trunk', 'main'], 'y\n');
      expect(init.status).toBe(0);
      expect(init.stdout).toContain('worktrees');
      // Store lands in the shared git dir, not the worktree's `.git` file.
      expect(existsSync(join(repo.bareDir, 'ly', 'meta.json'))).toBe(true);

      expect(main.ly(['create', 'feature-a', '-m', 'feat: a']).status).toBe(0);

      // A second worktree sees the branch created from the first.
      const log = other.ly(['log']);
      expect(log.status).toBe(0);
      expect(log.stdout).toContain('feature-a');
    },
  );

  it(
    'refuses to move a branch checked out in another worktree',
    { timeout: 30_000 },
    () => {
      const repo = createBareClone();
      const main = repo.addWorktree('main', 'main');
      main.ly(['init', '--trunk', 'main'], 'y\n');
      main.ly(['create', 'feature-a', '-m', 'feat: a']);
      main.ly(['create', 'feature-b', '-m', 'feat: b']);
      main.ly(['checkout', 'main']);

      // feature-b is now checked out in its own worktree.
      repo.addWorktree('wb', 'feature-b');

      const restack = main.ly(['restack', '--all']);
      expect(restack.status).toBe(1);
      expect(restack.stderr).toContain('feature-b');
      expect(restack.stderr).toContain('another worktree');

      const checkout = main.ly(['checkout', 'feature-b']);
      expect(checkout.status).toBe(1);
      expect(checkout.stderr).toContain('another worktree');

      // Once the conflicting worktree is gone, the operation proceeds.
      repo.removeWorktree('wb');
      expect(main.ly(['restack', '--all']).status).toBe(0);
    },
  );

  it(
    'syncs from a feature worktree while trunk lives in another',
    { timeout: 30_000 },
    () => {
      const repo = createBareClone();
      const main = repo.addWorktree('main', 'main');
      main.ly(['init', '--trunk', 'main'], 'y\n');
      expect(main.ly(['create', 'feature-a', '-m', 'feat: a']).status).toBe(0);
      main.ly(['checkout', 'main']);

      // feature-a moves into its own worktree; trunk stays checked out in `main`.
      const feat = repo.addWorktree('wa', 'feature-a');

      const res = feat.ly(['sync']);
      expect(res.stderr).not.toContain('cannot force update');
      expect(res.status).toBe(0);
    },
  );
});
