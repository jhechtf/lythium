import { describe, expect, it } from 'vitest';
import { createTempRepo, createUninitializedRepo } from './helpers/repo.ts';

describe('ly create', () => {
  it('creates a new stacked branch with --message', () => {
    const { ly, git } = createTempRepo();

    const result = ly([
      'create',
      'feat/my-feature',
      '--message',
      'feat: my feature',
    ]);

    expect(result.status).toBe(0);
    expect(git('branch --show-current')).toBe('feat/my-feature');
  });

  it('stacks the new branch on top of the current branch', () => {
    const { ly, git } = createTempRepo();

    ly(['create', 'feat/a', '--message', 'feat: a']);
    ly(['create', 'feat/b', '--message', 'feat: b']);

    expect(git('branch --show-current')).toBe('feat/b');
    // feat/b is a child of feat/a
    expect(git('log --oneline -2')).toContain('feat: a');
  });

  it('exits 1 when Lythium is not initialized', () => {
    const { ly } = createUninitializedRepo();
    const result = ly(['create', 'feat/x', '--message', 'msg']);
    expect(result.status).toBe(1);
  });
});

describe('ly log', () => {
  it('shows trunk and no-stacks message when no branches exist', () => {
    const { ly } = createTempRepo();

    const result = ly(['log']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('main');
    expect(result.stdout).toContain('no stacks');
  });

  it('shows created branches in the tree', () => {
    const { ly } = createTempRepo();

    const createResult = ly(['create', 'feat/a', '--message', 'feat: a']);
    expect(createResult.status).toBe(0);
    const result = ly(['log']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('feat/a');
  });

  it('--short shows lineage from trunk to current branch', () => {
    const { ly } = createTempRepo();

    ly(['create', 'feat/a', '--message', 'feat: a']);
    ly(['create', 'feat/b', '--message', 'feat: b']);
    const result = ly(['log', '--short']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('main');
    expect(result.stdout).toContain('feat/a');
    expect(result.stdout).toContain('feat/b');
  });

  it('exits 1 when Lythium is not initialized', () => {
    const { ly } = createUninitializedRepo();
    const result = ly(['log']);
    expect(result.status).toBe(1);
  });
});
