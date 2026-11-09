import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  buildPRDetails,
  type GithubCheckRun,
  type GithubCommit,
  type GithubPRFull,
  type GithubReview,
} from './pr-details.ts';
import type {
  DiffFile,
  PRDetailsResponse,
  StackDiffResponse,
  StackItem,
  StackPR,
} from './types.ts';

interface GithubPR {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
}

interface GithubFile {
  filename: string;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

interface GithubCompare {
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: GithubFile[];
}

const MAX_STACK_DEPTH = 20;

const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'lythium-api',
});

async function githubFetch(path: string, token: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(token),
  });
  const data = res.ok ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function shapePR(pr: GithubPR): StackPR {
  return {
    number: pr.number,
    title: pr.title,
    html_url: pr.html_url,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: pr.head.label },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: pr.base.label },
  };
}

type FetchResult = Awaited<ReturnType<typeof githubFetch>>;

function upstreamError(c: Context, result: FetchResult, prNumber: string) {
  if (result.status === 401)
    return c.json({ error: 'GitHub authentication failed' }, 401);
  if (result.status === 404)
    return c.json({ error: `PR #${prNumber} not found` }, 404);
  if (result.status === 403 || result.status === 429) {
    const retryAfter = result.headers.get('Retry-After');
    return c.json({ error: 'GitHub rate limit exceeded', retryAfter }, 429);
  }
  return c.json({ error: 'GitHub API error' }, 502);
}

// Hosting platforms we can talk to. `:source` in the URL selects one; only
// GitHub has an implementation today (GitLab / Forgejo are planned).
const SUPPORTED_SOURCES = ['github'] as const;

function unsupportedSource(c: Context, source: string) {
  if ((SUPPORTED_SOURCES as readonly string[]).includes(source)) return null;
  return c.json(
    {
      error: `Unsupported source '${source}'`,
      supported: SUPPORTED_SOURCES,
    },
    400,
  );
}

export const app = new Hono()
  .use('*', cors())
  .get('/repos/:source/:owner/:repo/pr/:pr_number/diff', async (c) => {
    const badSource = unsupportedSource(c, c.req.param('source'));
    if (badSource) return badSource;
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }
    const token = authHeader.slice(7);

    const { owner, repo, pr_number } = c.req.param();

    // Fetch the starting PR
    const startResult = await githubFetch(
      `/repos/${owner}/${repo}/pulls/${pr_number}`,
      token,
    );
    if (!startResult.ok) return upstreamError(c, startResult, pr_number);

    // Walk UP the stack: follow base.ref to find parent PRs
    const prs: GithubPR[] = [startResult.data as GithubPR];
    let current = startResult.data as GithubPR;

    for (let i = 0; i < MAX_STACK_DEPTH - 1; i++) {
      const parentBranch = current.base.ref;
      const searchResult = await githubFetch(
        `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(parentBranch)}&state=open`,
        token,
      );
      if (
        !searchResult.ok ||
        !Array.isArray(searchResult.data) ||
        searchResult.data.length === 0
      ) {
        break; // no parent PR found — we're at the bottom of the stack
      }
      const parentPR = (searchResult.data as GithubPR[])[0];
      prs.unshift(parentPR); // prepend so array stays bottom-to-top
      current = parentPR;
    }

    // Fetch diff for each PR in the stack
    const stack: StackItem[] = [];
    for (const pr of prs) {
      const compareResult = await githubFetch(
        `/repos/${owner}/${repo}/compare/${pr.base.sha}...${pr.head.sha}`,
        token,
      );

      if (!compareResult.ok) {
        stack.push({
          pr: shapePR(pr),
          diff: {
            stats: { ahead_by: 0, behind_by: 0, total_commits: 0 },
            files: [],
          },
        });
        continue;
      }

      const cmp = compareResult.data as GithubCompare;
      stack.push({
        pr: shapePR(pr),
        diff: {
          stats: {
            ahead_by: cmp.ahead_by,
            behind_by: cmp.behind_by,
            total_commits: cmp.total_commits,
          },
          files: (cmp.files ?? []).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch,
            previous_filename: f.previous_filename,
          })),
        },
      });
    }

    return c.json<StackDiffResponse>({ stack });
  })
  .get('/repos/:source/:owner/:repo/pr/:pr_number', async (c) => {
    const badSource = unsupportedSource(c, c.req.param('source'));
    if (badSource) return badSource;
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }
    const token = authHeader.slice(7);
    const { owner, repo, pr_number } = c.req.param();
    const base = `/repos/${owner}/${repo}`;

    const prResult = await githubFetch(`${base}/pulls/${pr_number}`, token);
    if (!prResult.ok) return upstreamError(c, prResult, pr_number);
    const pr = prResult.data as GithubPRFull;

    const [reviewsResult, commitResult, checksResult, parentResult] =
      await Promise.all([
        githubFetch(`${base}/pulls/${pr_number}/reviews?per_page=100`, token),
        // `commits` is capped at 250; page size 1 on the last page = newest.
        githubFetch(
          `${base}/pulls/${pr_number}/commits?per_page=1&page=${Math.min(Math.max(pr.commits ?? 1, 1), 250)}`,
          token,
        ),
        githubFetch(
          `${base}/commits/${pr.head.sha}/check-runs?per_page=100`,
          token,
        ),
        githubFetch(
          `${base}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(pr.base.ref)}&state=open`,
          token,
        ),
      ]);

    if (!reviewsResult.ok) return upstreamError(c, reviewsResult, pr_number);
    if (!commitResult.ok) return upstreamError(c, commitResult, pr_number);

    // Checks and parent lookup degrade gracefully: a token without checks
    // access shouldn't make the whole PR unreadable.
    const checks = checksResult.ok
      ? ((checksResult.data as { check_runs?: GithubCheckRun[] }).check_runs ??
        [])
      : null;
    const parentList =
      parentResult.ok && Array.isArray(parentResult.data)
        ? (parentResult.data as { number: number }[])
        : [];
    // Only a still-open parent blocks; merged parents aren't returned by state=open.
    const parentPr =
      pr.state === 'open' ? (parentList[0]?.number ?? null) : null;

    return c.json<PRDetailsResponse>(
      buildPRDetails({
        pr,
        reviews: reviewsResult.data as GithubReview[],
        latestCommit: (commitResult.data as GithubCommit[])[0],
        checks,
        parentPr,
      }),
    );
  });

export type AppType = typeof app;
