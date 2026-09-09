import { isCancel, multiselect, outro } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { fetch as undiciFetch } from 'undici';
import { getToken } from '../credentials.ts';
import {
  checkout,
  currentBranch,
  deleteBranch,
  fetch,
  forceRebase,
  getRemoteUrl,
  isMergedInto,
  listLocalBranches,
  parseOwnerRepo,
  trackRemoteBranch,
  updateTrunk,
} from '../git.ts';
import { getAllDescendants, STACK_END, STACK_START } from '../stack.ts';
import {
  type BranchMeta,
  LyError,
  type LyStore,
  load,
  save,
} from '../store.ts';
import { guardBranchesAvailable } from '../worktree.ts';

// ─── Rebuild helpers ──────────────────────────────────────────────────────────

interface ParsedEntry {
  name: string;
  prNumber?: number;
  prUrl?: string;
  isTrunk: boolean;
}

interface GithubPR {
  body: string | null;
}

async function githubGet<T>(path: string, token: string): Promise<T> {
  const res = await undiciFetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lythium-cli',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function parseStackLine(raw: string): ParsedEntry | null {
  const line = raw
    .replace(/^-\s+/, '')
    .replace(/^\*\*/, '')
    .replace(/\s*←\s*this PR\*\*$/, '')
    .trim();

  const trunkMatch = line.match(/^`(.+?)`\s+\(trunk\)$/);
  if (trunkMatch) return { name: trunkMatch[1], isTrunk: true };

  const prMatch = line.match(/^\[(.+?)\]\((.+?)\)\s+\(#(\d+)\)$/);
  if (prMatch) {
    return {
      name: prMatch[1],
      prUrl: prMatch[2],
      prNumber: Number.parseInt(prMatch[3], 10),
      isTrunk: false,
    };
  }

  const nameMatch = line.match(/^`(.+?)`$/);
  if (nameMatch) return { name: nameMatch[1], isTrunk: false };

  return null;
}

function parseStackSection(body: string): ParsedEntry[] | null {
  const startIdx = body.indexOf(STACK_START);
  const endIdx = body.indexOf(STACK_END);
  if (startIdx === -1 || endIdx === -1) return null;

  const section = body.slice(startIdx + STACK_START.length, endIdx);
  const entries = section
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .map(parseStackLine)
    .filter((e): e is ParsedEntry => e !== null);

  return entries.length > 0 ? entries : null;
}

async function rebuildStore(
  owner: string,
  repo: string,
  token: string,
): Promise<LyStore> {
  // Page through all open PRs
  process.stdout.write(pc.dim('Querying open PRs... '));
  let allPRs: GithubPR[] = [];
  let page = 1;
  while (true) {
    const batch = await githubGet<GithubPR[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      token,
    );
    allPRs = allPRs.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  process.stdout.write(pc.green(`✓ (${allPRs.length} open PR(s))\n`));

  const stackPRs = allPRs.filter((pr) => pr.body?.includes(STACK_START));
  if (stackPRs.length === 0) {
    throw new LyError(
      'No open PRs with lythium stack sections found. Cannot rebuild.',
    );
  }

  // Union all parsed chains into a single branch graph.
  // Each chain is ordered trunk → … → leaf, so entry[i]'s parent is entry[i-1].
  // Prefer entries that carry PR metadata over those that don't.
  let trunk: string | null = null;
  const branches: Record<string, BranchMeta> = {};

  for (const pr of stackPRs) {
    const entries = parseStackSection(pr.body ?? '');
    if (!entries) continue;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      if (entry.isTrunk) {
        trunk = entry.name;
        continue;
      }

      const parent = entries[i - 1]?.name ?? trunk;
      if (!parent) continue;

      const existing = branches[entry.name];
      if (!existing || (!existing.prNumber && entry.prNumber)) {
        branches[entry.name] = {
          parent,
          ...(entry.prNumber
            ? { prNumber: entry.prNumber, prUrl: entry.prUrl }
            : {}),
        };
      }
    }
  }

  if (!trunk) {
    throw new LyError('Could not determine trunk branch from stack sections.');
  }

  // Track remote branches that aren't present locally yet
  const localBranches = new Set(listLocalBranches());
  const toTrack = Object.keys(branches).filter((b) => !localBranches.has(b));

  if (toTrack.length > 0) {
    console.log(pc.dim('\nTracking remote branches:'));
    for (const b of toTrack) {
      process.stdout.write(pc.dim(`  ${b}... `));
      try {
        trackRemoteBranch(b);
        process.stdout.write(pc.green('✓\n'));
      } catch {
        // Branch hasn't been pushed yet (local-only on originating machine)
        process.stdout.write(pc.yellow('not on remote, skipping\n'));
        delete branches[b];
      }
    }
  }

  return { trunk, branches };
}

// ─── Command ──────────────────────────────────────────────────────────────────

program
  .command('sync')
  .description('Fetch from origin, clean up merged branches, and restack')
  .option(
    '--rebuild',
    'rebuild the local stack graph from open GitHub PRs (use when switching machines)',
  )
  .action(async (opts: { rebuild?: boolean }) => {
    let store: LyStore;

    if (opts.rebuild) {
      const token = getToken();
      if (!token) {
        console.error(
          pc.red(
            'Not logged in. Run `ly auth login` to authenticate with GitHub.',
          ),
        );
        process.exit(1);
      }

      let owner: string;
      let repo: string;
      try {
        ({ owner, repo } = parseOwnerRepo(getRemoteUrl()));
      } catch (e) {
        console.error(pc.red((e as Error).message));
        process.exit(1);
      }

      // Fetch first so trackRemoteBranch has up-to-date refs
      process.stdout.write(pc.dim('Fetching from origin... '));
      try {
        fetch();
        process.stdout.write(pc.green('✓\n'));
      } catch (e) {
        process.stdout.write(pc.red('✗\n'));
        console.error(pc.red(`Fetch failed: ${(e as Error).message}`));
        process.exit(1);
      }

      try {
        store = await rebuildStore(owner, repo, token);
      } catch (e) {
        console.error(pc.red(e instanceof LyError ? e.message : String(e)));
        process.exit(1);
      }

      console.log(
        pc.dim(
          `\nRebuilt stack: ${Object.keys(store.branches).length} branch(es) under ${pc.bold(store.trunk)}`,
        ),
      );
    } else {
      try {
        store = load();
      } catch (e) {
        console.error(pc.red(e instanceof LyError ? e.message : String(e)));
        if (e instanceof LyError) {
          console.error(
            pc.dim(
              'Tip: run `ly sync --rebuild` to rebuild from open GitHub PRs.',
            ),
          );
        }
        process.exit(1);
      }

      // Fetch
      process.stdout.write(pc.dim('Fetching from origin... '));
      try {
        fetch();
        process.stdout.write(pc.green('✓\n'));
      } catch (e) {
        process.stdout.write(pc.red('✗\n'));
        console.error(pc.red(`Fetch failed: ${(e as Error).message}`));
        process.exit(1);
      }
    }

    // sync updates the local trunk, then deletes, reparents, checks out and
    // rebases tracked branches. If any of them is checked out in another
    // worktree, none of that can proceed — fail now, before mutating anything
    // (including the trunk update below).
    guardBranchesAvailable(Object.keys(store.branches));

    // Bring the local trunk up to date so restacks target the new base
    process.stdout.write(pc.dim(`Updating ${store.trunk}... `));
    try {
      updateTrunk(store.trunk);
      process.stdout.write(pc.green('✓\n'));
    } catch (e) {
      process.stdout.write(pc.yellow('skipped\n'));
      console.warn(
        pc.yellow(
          `Could not fast-forward ${store.trunk}: ${(e as Error).message}`,
        ),
      );
      // A stale trunk would make the restack below target an outdated base,
      // leaving the stack inconsistent. Bail out before mutating anything.
      console.error(
        pc.red(
          `Aborting sync: update ${store.trunk} manually and re-run \`ly sync\`.`,
        ),
      );
      process.exit(1);
    }

    // Detect merged branches
    const trackedBranches = Object.keys(store.branches);
    const merged = trackedBranches.filter((b) => {
      try {
        return isMergedInto(b, `origin/${store.trunk}`);
      } catch {
        return false;
      }
    });

    const origin = currentBranch();

    // Branches that are merged but the user chooses to keep — excluded from the
    // restack below so we don't rebase them into an empty no-op.
    const mergedKept = new Set<string>();

    if (merged.length > 0) {
      console.log(pc.dim(`\nFound ${merged.length} merged branch(es):`));
      for (const b of merged) console.log(pc.dim(`  ${b}`));

      const toDelete = await multiselect({
        message: 'Delete these merged branches? (all selected by default)',
        options: merged.map((b) => ({
          value: b,
          label: b,
          hint: `merged into ${store.trunk}`,
        })),
        initialValues: merged,
        required: false,
      });

      const selected = isCancel(toDelete) ? [] : (toDelete as string[]);

      for (const b of selected) {
        const meta = store.branches[b];
        const children = Object.entries(store.branches).filter(
          ([, m]) => m.parent === b,
        );
        for (const [child, childMeta] of children) {
          childMeta.parent = meta.parent;
          console.log(pc.dim(`  Reparenting ${child} → ${meta.parent}`));
        }

        if (currentBranch() === b) {
          checkout(meta.parent);
        }
        try {
          deleteBranch(b, true);
        } catch (e) {
          // Tolerate an already-absent branch; re-throw anything else (e.g. the
          // branch is checked out in another worktree) so we don't drop metadata
          // for a branch that still exists locally.
          if (listLocalBranches().includes(b)) throw e;
        }
        delete store.branches[b];
        console.log(pc.green(`  Deleted ${b}`));
      }

      for (const b of merged) {
        if (store.branches[b]) {
          mergedKept.add(b);
          console.log(
            pc.yellow(
              `  ${b} is fully merged into ${store.trunk} — kept, skipping its rebase`,
            ),
          );
        }
      }
    } else {
      console.log(pc.dim('No merged branches found.'));
    }

    // Restack remaining branches onto their (now up-to-date) parents
    const toRestack = getAllDescendants(store, store.trunk).filter(
      (b) => !mergedKept.has(b),
    );
    if (toRestack.length > 0) {
      console.log(pc.dim(`\nRestacking ${toRestack.length} branch(es)...`));
      for (const b of toRestack) {
        const parent = store.branches[b].parent;
        console.log(pc.dim(`  ${b} → ${parent}`));
        forceRebase(b, parent, origin);
      }
    }

    // Return to where we started, or trunk if that branch was just deleted
    checkout(listLocalBranches().includes(origin) ? origin : store.trunk);

    save(store);
    outro(pc.green('Sync complete'));
  });
