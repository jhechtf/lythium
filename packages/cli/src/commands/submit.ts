import { outro } from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import { fetch as undiciFetch } from 'undici';
import { getToken } from '../credentials.ts';
import { currentBranch, getRemoteUrl, parseOwnerRepo, push } from '../git.ts';
import { buildStackSection, getStack, stripStackSection } from '../stack.ts';
import { LyError, type LyStore, load, save } from '../store.ts';

interface GithubPRResponse {
  number: number;
  html_url: string;
  body?: string;
}

async function githubRequest(
  method: string,
  path: string,
  token: string,
  body?: object,
): Promise<unknown> {
  const res = await undiciFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'lythium-cli',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }

  return res.json();
}

program
  .command('submit')
  .description('Push branches and create/update GitHub PRs')
  .option('--stack', 'submit the entire stack, not just the current branch')
  .option('--draft', 'create PRs as drafts')
  .option('--title <title>', 'PR title (single branch only)')
  .option('--body <body>', 'PR body / description')
  .action(
    async (opts: {
      stack?: boolean;
      draft?: boolean;
      title?: string;
      body?: string;
    }) => {
      let store: LyStore;
      try {
        store = load();
      } catch (e) {
        console.error(pc.red(e instanceof LyError ? e.message : String(e)));
        process.exit(1);
      }

      const token = getToken();
      if (!token) {
        console.error(
          pc.red(
            'Not logged in. Run `ly auth login` to authenticate with GitHub.',
          ),
        );
        process.exit(1);
      }

      let remoteUrl: string;
      let owner: string;
      let repo: string;
      try {
        remoteUrl = getRemoteUrl();
        ({ owner, repo } = parseOwnerRepo(remoteUrl));
      } catch (e) {
        console.error(pc.red((e as Error).message));
        process.exit(1);
      }

      const branch = currentBranch();

      if (branch === store.trunk) {
        console.error(
          pc.red('Cannot submit trunk. Switch to a stacked branch first.'),
        );
        process.exit(1);
      }

      if (!store.branches[branch]) {
        console.error(
          pc.red(
            `Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`,
          ),
        );
        process.exit(1);
      }

      // Determine which branches to submit (bottom-up order)
      const branches = opts.stack
        ? getStack(store, branch).filter((b) => b !== store.trunk)
        : [branch];

      console.log(
        pc.dim(
          `Submitting ${branches.length} branch(es) to ${owner}/${repo}...`,
        ),
      );

      // Phase 1: push + create/update all PRs so every PR number is known before
      // we build stack sections. Track the base body (user content, no stack section)
      // for each branch so we can compose the final body in phase 2.
      const baseBodies = new Map<string, string>();

      for (const b of branches) {
        const meta = store.branches[b];
        const base = meta.parent;

        // Push the branch
        process.stdout.write(pc.dim(`  pushing ${b}... `));
        try {
          push(b, true);
          process.stdout.write(pc.green('✓\n'));
        } catch (e) {
          process.stdout.write(pc.red('✗\n'));
          console.error(
            pc.red(`  Failed to push ${b}: ${(e as Error).message}`),
          );
          process.exit(1);
        }

        // Check if PR already exists
        let existing: GithubPRResponse[];
        try {
          existing = (await githubRequest(
            'GET',
            `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(b)}&state=open`,
            token,
          )) as GithubPRResponse[];
        } catch (e) {
          console.error(
            pc.red(
              `  Failed to list PRs for ${pc.bold(b)}: ${(e as Error).message}`,
            ),
          );
          process.exit(1);
        }

        if (existing?.length > 0) {
          // Update existing PR
          const pr = existing?.[0];
          try {
            await githubRequest(
              'PATCH',
              `/repos/${owner}/${repo}/pulls/${pr.number}`,
              token,
              {
                base,
                ...(opts.title && branches.length === 1
                  ? { title: opts.title }
                  : {}),
              },
            );
          } catch (e) {
            console.error(
              pc.red(
                `  Failed to update PR #${pr.number} for ${pc.bold(b)}: ${(e as Error).message}`,
              ),
            );
            process.exit(1);
          }
          meta.prNumber = pr.number;
          meta.prUrl = pr.html_url;
          // Strip any old stack section so phase 2 can rewrite it cleanly
          baseBodies.set(b, stripStackSection(opts.body ?? pr.body ?? ''));
          console.log(pc.dim(`  updated PR #${pr.number}: ${pr.html_url}`));
        } else {
          // Create new PR
          const title = opts.title && branches.length === 1 ? opts.title : b;
          let created: GithubPRResponse;
          try {
            created = (await githubRequest(
              'POST',
              `/repos/${owner}/${repo}/pulls`,
              token,
              {
                title,
                head: b,
                base,
                body: opts.body ?? '',
                draft: opts.draft ?? false,
              },
            )) as GithubPRResponse;
          } catch (e) {
            console.error(
              pc.red(
                `  Failed to create PR for ${pc.bold(b)}: ${(e as Error).message}`,
              ),
            );
            process.exit(1);
          }
          meta.prNumber = created.number;
          meta.prUrl = created.html_url;
          baseBodies.set(b, opts.body ?? '');
          console.log(
            pc.green(`  created PR #${created.number}: ${created.html_url}`),
          );
        }

        save(store);
      }

      // Phase 2: now that all PR numbers are known, update each PR body with the
      // stack section so every PR in the batch links to the others.
      console.log(pc.dim('  updating stack sections...'));
      for (const b of branches) {
        const meta = store.branches[b];
        if (!meta.prNumber) continue;

        const base = baseBodies.get(b) ?? '';
        const section = buildStackSection(store, b);
        const fullBody = base ? `${base}\n\n${section}` : section;

        try {
          await githubRequest(
            'PATCH',
            `/repos/${owner}/${repo}/pulls/${meta.prNumber}`,
            token,
            {
              body: fullBody,
            },
          );
        } catch (e) {
          // Non-fatal — the PR exists and is correct, only the stack section failed
          console.error(
            pc.yellow(
              `  Warning: could not update stack section on #${meta.prNumber}: ${(e as Error).message}`,
            ),
          );
        }
      }

      outro(pc.green(`Submitted ${branches.length} branch(es)`));
    },
  );
