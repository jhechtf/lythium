import { program } from 'commander';
import { outro } from '@clack/prompts';
import pc from 'picocolors';
import { fetch as undiciFetch } from 'undici';
import { getToken } from '../credentials.ts';
import { currentBranch, push, getRemoteUrl, parseOwnerRepo } from '../git.ts';
import { load, save, LyError } from '../store.ts';
import { getStack } from '../stack.ts';

async function githubRequest(
  method: string,
  path: string,
  token: string,
  body?: object,
): Promise<any> {
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
  .action(async (opts: { stack?: boolean; draft?: boolean; title?: string; body?: string }) => {
    let store;
    try {
      store = load();
    } catch (e) {
      console.error(pc.red(e instanceof LyError ? e.message : String(e)));
      process.exit(1);
    }

    const token = getToken();
    if (!token) {
      console.error(pc.red('Not logged in. Run `ly auth login` to authenticate with GitHub.'));
      process.exit(1);
    }

    let remoteUrl: string;
    let owner: string;
    let repo: string;
    try {
      remoteUrl = getRemoteUrl();
      ({ owner, repo } = parseOwnerRepo(remoteUrl));
    } catch (e: any) {
      console.error(pc.red(e.message));
      process.exit(1);
    }

    const branch = currentBranch();

    if (branch === store.trunk) {
      console.error(pc.red('Cannot submit trunk. Switch to a stacked branch first.'));
      process.exit(1);
    }

    if (!store.branches[branch]) {
      console.error(pc.red(`Branch ${pc.bold(branch)} is not tracked. Run \`ly track\` to add it.`));
      process.exit(1);
    }

    // Determine which branches to submit (bottom-up order)
    const branches = opts.stack
      ? getStack(store, branch).filter((b) => b !== store.trunk)
      : [branch];

    console.log(pc.dim(`Submitting ${branches.length} branch(es) to ${owner}/${repo}...`));

    for (const b of branches) {
      const meta = store.branches[b];
      const base = meta.parent;

      // Push the branch
      process.stdout.write(pc.dim(`  pushing ${b}... `));
      try {
        push(b, true);
        process.stdout.write(pc.green('✓\n'));
      } catch (e: any) {
        process.stdout.write(pc.red('✗\n'));
        console.error(pc.red(`  Failed to push ${b}: ${e.message}`));
        process.exit(1);
      }

      // Check if PR already exists
      const existing: any[] = await githubRequest(
        'GET',
        `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(b)}&state=open`,
        token,
      );

      if (existing.length > 0) {
        // Update existing PR
        const pr = existing[0];
        await githubRequest('PATCH', `/repos/${owner}/${repo}/pulls/${pr.number}`, token, {
          base,
          ...(opts.title && branches.length === 1 ? { title: opts.title } : {}),
          ...(opts.body ? { body: opts.body } : {}),
        });
        meta.prNumber = pr.number;
        meta.prUrl = pr.html_url;
        console.log(pc.dim(`  updated PR #${pr.number}: ${pr.html_url}`));
      } else {
        // Create new PR
        const title = (opts.title && branches.length === 1) ? opts.title : b;
        const created: any = await githubRequest(
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
        );
        meta.prNumber = created.number;
        meta.prUrl = created.html_url;
        console.log(pc.green(`  created PR #${created.number}: ${created.html_url}`));
      }
    }

    save(store);
    outro(pc.green(`Submitted ${branches.length} branch(es)`));
  });
