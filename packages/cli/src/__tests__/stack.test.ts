import { describe, expect, it } from 'vitest';
import {
  buildStackSection,
  getAllDescendants,
  getAncestors,
  getChildren,
  getStack,
  stripStackSection,
} from '../stack.ts';
import type { LyStore } from '../store.ts';

// Strip ANSI escape codes so rendering tests are readable
function stripAnsi(str: string): string {
  return str.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
    '',
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function linearStore(): LyStore {
  return {
    trunk: 'main',
    branches: {
      feat_a: { parent: 'main' },
      feat_b: { parent: 'feat_a' },
      feat_c: { parent: 'feat_b' },
    },
  };
}

function treeStore(): LyStore {
  return {
    trunk: 'main',
    branches: {
      feat_a: { parent: 'main' },
      feat_b: { parent: 'main' },
      feat_c: { parent: 'feat_a' },
      feat_d: { parent: 'feat_a' },
    },
  };
}

function emptyStore(): LyStore {
  return { trunk: 'main', branches: {} };
}

// ─── getChildren ─────────────────────────────────────────────────────────────

describe('getChildren', () => {
  it('returns direct children of trunk', () => {
    expect(getChildren(linearStore(), 'main')).toEqual(['feat_a']);
  });

  it('returns multiple children', () => {
    const children = getChildren(treeStore(), 'main');
    expect(children).toHaveLength(2);
    expect(children).toContain('feat_a');
    expect(children).toContain('feat_b');
  });

  it('returns empty array for a leaf branch', () => {
    expect(getChildren(linearStore(), 'feat_c')).toEqual([]);
  });

  it('returns empty array when trunk has no branches', () => {
    expect(getChildren(emptyStore(), 'main')).toEqual([]);
  });
});

// ─── getAllDescendants ────────────────────────────────────────────────────────

describe('getAllDescendants', () => {
  it('returns BFS-ordered descendants of trunk', () => {
    const descendants = getAllDescendants(linearStore(), 'main');
    expect(descendants).toEqual(['feat_a', 'feat_b', 'feat_c']);
  });

  it('returns BFS order for branching tree', () => {
    const descendants = getAllDescendants(treeStore(), 'main');
    // feat_a and feat_b come before their children
    expect(descendants.indexOf('feat_a')).toBeLessThan(
      descendants.indexOf('feat_c'),
    );
    expect(descendants.indexOf('feat_a')).toBeLessThan(
      descendants.indexOf('feat_d'),
    );
    expect(descendants).toHaveLength(4);
  });

  it('returns empty array for a leaf', () => {
    expect(getAllDescendants(linearStore(), 'feat_c')).toEqual([]);
  });
});

// ─── getAncestors ─────────────────────────────────────────────────────────────

describe('getAncestors', () => {
  it('returns empty array for a branch directly on trunk', () => {
    expect(getAncestors(linearStore(), 'feat_a')).toEqual([]);
  });

  it('returns intermediate branches, excluding trunk', () => {
    expect(getAncestors(linearStore(), 'feat_c')).toEqual(['feat_a', 'feat_b']);
  });

  it('returns single intermediate for two-level stack', () => {
    expect(getAncestors(linearStore(), 'feat_b')).toEqual(['feat_a']);
  });
});

// ─── getStack ────────────────────────────────────────────────────────────────

describe('getStack', () => {
  it('includes trunk and branch for a direct stack member', () => {
    expect(getStack(linearStore(), 'feat_a')).toEqual(['main', 'feat_a']);
  });

  it('returns full path trunk → branch for deep stack', () => {
    expect(getStack(linearStore(), 'feat_c')).toEqual([
      'main',
      'feat_a',
      'feat_b',
      'feat_c',
    ]);
  });
});

// ─── buildStackSection ───────────────────────────────────────────────────────

describe('buildStackSection', () => {
  it('marks the current branch with "← this PR"', () => {
    const section = buildStackSection(linearStore(), 'feat_a');
    expect(section).toContain('← this PR');
    expect(section).toContain('feat_a');
  });

  it('includes trunk label', () => {
    const section = buildStackSection(linearStore(), 'feat_a');
    expect(section).toContain('main');
    expect(section).toContain('trunk');
  });

  it('includes descendants below the current branch', () => {
    const section = buildStackSection(linearStore(), 'feat_a');
    expect(section).toContain('feat_b');
    expect(section).toContain('feat_c');
  });

  it('wraps content with lythium stack markers', () => {
    const section = buildStackSection(linearStore(), 'feat_a');
    expect(section).toContain('<!-- lythium-stack-start -->');
    expect(section).toContain('<!-- lythium-stack-end -->');
  });

  it('renders PR link when prUrl and prNumber are present', () => {
    const store: LyStore = {
      trunk: 'main',
      branches: {
        feat_a: {
          parent: 'main',
          prNumber: 42,
          prUrl: 'https://github.com/o/r/pull/42',
        },
      },
    };
    const section = buildStackSection(store, 'feat_a');
    expect(section).toContain('https://github.com/o/r/pull/42');
    expect(section).toContain('#42');
  });
});

// ─── stripStackSection ───────────────────────────────────────────────────────

describe('stripStackSection', () => {
  it('removes an embedded stack section', () => {
    const body = `My PR description.\n${buildStackSection(linearStore(), 'feat_a')}`;
    const stripped = stripStackSection(body);
    expect(stripped).toBe('My PR description.');
    expect(stripped).not.toContain('lythium-stack');
  });

  it('is a no-op when no stack section is present', () => {
    const body = 'Plain PR body.';
    expect(stripStackSection(body)).toBe('Plain PR body.');
  });

  it('removes multiple embedded sections', () => {
    const section = buildStackSection(linearStore(), 'feat_a');
    const body = `Before\n${section}\nMiddle\n${section}\nAfter`;
    const stripped = stripStackSection(body);
    expect(stripped).not.toContain('lythium-stack');
  });
});

// ─── renderTree / renderShortStack (smoke tests) ─────────────────────────────

describe('renderTree', () => {
  it('includes all branch names', async () => {
    const { renderTree } = await import('../stack.ts');
    const output = stripAnsi(renderTree(linearStore(), 'main'));
    expect(output).toContain('main');
    expect(output).toContain('feat_a');
    expect(output).toContain('feat_b');
    expect(output).toContain('feat_c');
  });

  it('marks the current branch with an asterisk', async () => {
    const { renderTree } = await import('../stack.ts');
    const output = stripAnsi(renderTree(linearStore(), 'feat_b'));
    expect(output).toContain('feat_b *');
  });

  it('shows a message when no stacks exist', async () => {
    const { renderTree } = await import('../stack.ts');
    const output = stripAnsi(renderTree(emptyStore(), 'main'));
    expect(output).toContain('no stacks');
  });
});

describe('renderShortStack', () => {
  it('lists all branches from trunk to current', async () => {
    const { renderShortStack } = await import('../stack.ts');
    const output = stripAnsi(renderShortStack(linearStore(), 'feat_b'));
    expect(output).toContain('main');
    expect(output).toContain('feat_a');
    expect(output).toContain('feat_b');
  });

  it('marks the current branch with an asterisk', async () => {
    const { renderShortStack } = await import('../stack.ts');
    const output = stripAnsi(renderShortStack(linearStore(), 'feat_b'));
    expect(output).toContain('feat_b *');
  });
});
