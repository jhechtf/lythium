import pc from 'picocolors';
import type { LyStore } from './store.ts';

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

// ─── PR body stack section ───────────────────────────────────────────────────

const STACK_START = '<!-- lythium-stack-start -->';
const STACK_END = '<!-- lythium-stack-end -->';

function formatBranchEntry(store: LyStore, b: string): string {
  const meta = store.branches[b];
  if (b === store.trunk) return `\`${b}\` (trunk)`;
  if (meta?.prUrl && meta?.prNumber) return `[${b}](${meta.prUrl}) (#${meta.prNumber})`;
  return `\`${b}\``;
}

/** Build the markdown stack section to embed in a PR body. */
export function buildStackSection(store: LyStore, branch: string): string {
  const ancestors = getStack(store, branch); // trunk → branch
  const descendants = getAllDescendants(store, branch); // BFS children below branch

  const lines = [
    ...ancestors.map((b) => {
      const entry = formatBranchEntry(store, b);
      return b === branch ? `- **${entry} ← this PR**` : `- ${entry}`;
    }),
    ...descendants.map((b) => `- ${formatBranchEntry(store, b)}`),
  ];

  return [
    STACK_START,
    '---',
    '*Stack — managed by [lythium](https://github.com/jhechtf/lythium):*',
    '',
    ...lines,
    STACK_END,
  ].join('\n');
}

/** Strip a previously embedded stack section from a PR body. */
export function stripStackSection(body: string): string {
  return body
    .replace(new RegExp(`\\n*${STACK_START}[\\s\\S]*?${STACK_END}\\n*`, 'g'), '')
    .trimEnd();
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
    renderNode(
      store,
      child,
      currentBranch,
      childPrefix,
      i === children.length - 1,
    ),
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
    renderNode(store, child, currentBranch, '', i === children.length - 1),
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
