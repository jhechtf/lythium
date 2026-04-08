import type { LyStore } from './store.ts';
import pc from 'picocolors';

export function getChildren(store: LyStore, branch: string): string[] {
  return Object.entries(store.branches)
    .filter(([, meta]) => meta.parent === branch)
    .map(([name]) => name);
}

/** BFS-ordered list of all descendants (parent always before its children). */
export function getAllDescendants(store: LyStore, branch: string): string[] {
  const result: string[] = [];
  const queue = [...getChildren(store, branch)];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    result.push(curr);
    queue.push(...getChildren(store, curr));
  }
  return result;
}

/** Branches from `branch` up to (but not including) trunk. */
export function getAncestors(store: LyStore, branch: string): string[] {
  const ancestors: string[] = [];
  let current = branch;
  const seen = new Set<string>();
  while (store.branches[current] && !seen.has(current)) {
    seen.add(current);
    const parent = store.branches[current].parent;
    if (parent === store.trunk) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

/** Full linear path from trunk → branch (inclusive). */
export function getStack(store: LyStore, branch: string): string[] {
  return [store.trunk, ...getAncestors(store, branch), branch];
}

// ─── Tree rendering ──────────────────────────────────────────────────────────

function renderNode(
  store: LyStore,
  branch: string,
  currentBranch: string,
  prefix: string,
  isLast: boolean,
): string {
  const connector = isLast ? '└── ' : '├── ';
  const meta = store.branches[branch];
  const prInfo = meta?.prNumber ? pc.dim(` [PR #${meta.prNumber}]`) : '';
  const isCurrent = branch === currentBranch;
  const label = isCurrent ? pc.bold(pc.green(`${branch} *`)) : branch;

  const childPrefix = prefix + (isLast ? '    ' : '│   ');
  const children = getChildren(store, branch);
  const childLines = children.map((child, i) =>
    renderNode(store, child, currentBranch, childPrefix, i === children.length - 1)
  );

  return [`${prefix}${connector}${label}${prInfo}`, ...childLines].join('\n');
}

export function renderTree(store: LyStore, currentBranch: string): string {
  const isCurrent = store.trunk === currentBranch;
  const trunkLabel = isCurrent
    ? pc.bold(pc.green(`${store.trunk} *`))
    : pc.dim(store.trunk);

  const children = getChildren(store, store.trunk);
  if (children.length === 0) {
    return trunkLabel + pc.dim('  (no stacks — use `ly create` to start one)');
  }

  const childLines = children.map((child, i) =>
    renderNode(store, child, currentBranch, '', i === children.length - 1)
  );
  return [trunkLabel, ...childLines].join('\n');
}

export function renderShortStack(store: LyStore, branch: string): string {
  const stack = getStack(store, branch);
  return stack
    .map((b, i) => {
      const meta = store.branches[b];
      const prInfo = meta?.prNumber ? pc.dim(` [PR #${meta.prNumber}]`) : '';
      const isCurrent = b === branch;
      const indent = '  '.repeat(i);
      const label = isCurrent ? pc.bold(pc.green(`${b} *`)) : pc.dim(b);
      return `${indent}${label}${prInfo}`;
    })
    .join('\n');
}
