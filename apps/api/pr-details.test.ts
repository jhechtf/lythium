import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import {
  buildPRDetails,
  type GithubPRFull,
  mapReviewers,
} from './pr-details.ts';

const basePR = (over: Partial<GithubPRFull> = {}): GithubPRFull => ({
  number: 7,
  title: 'Add thing',
  body: 'body',
  html_url: 'https://github.com/o/r/pull/7',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'alice' },
  head: { ref: 'feat/b', sha: 'abcdef1234567', label: 'o:feat/b' },
  base: { ref: 'main', sha: '1111111', label: 'o:main' },
  labels: [{ name: 'bug', color: 'ff0000' }],
  requested_reviewers: [],
  requested_teams: [],
  additions: 10,
  deletions: 2,
  changed_files: 3,
  commits: 2,
  ...over,
});

const commit = {
  sha: 'abcdef1234567',
  commit: {
    message: 'feat: x\n\nbody',
    committer: { date: '2026-01-01T00:00:00Z' },
  },
};

describe('mapReviewers', () => {
  it('keeps the latest decision and ignores later comments', () => {
    const out = mapReviewers(
      [
        {
          user: { login: 'bob' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '1',
        },
        { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2' },
        { user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '3' },
      ],
      [],
    );
    expect(out).toEqual([{ login: 'bob', state: 'approved' }]);
  });

  it('does not report commenters or dismissed reviewers as pending', () => {
    const out = mapReviewers(
      [
        { user: { login: 'eve' }, state: 'COMMENTED', submitted_at: '1' },
        { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '1' },
        { user: { login: 'bob' }, state: 'DISMISSED', submitted_at: '2' },
      ],
      [],
    );
    expect(out).toEqual([]);
  });

  it('puts re-requested reviewers back in review', () => {
    const out = mapReviewers(
      [{ user: { login: 'bob' }, state: 'APPROVED', submitted_at: '1' }],
      ['bob', 'carol'],
    );
    expect(out).toEqual([
      { login: 'bob', state: 'in_review' },
      { login: 'carol', state: 'in_review' },
    ]);
  });
});

describe('buildPRDetails', () => {
  const run = (pr: GithubPRFull, extra = {}) =>
    buildPRDetails({
      pr,
      reviews: [],
      latestCommit: commit,
      checks: [],
      parentPr: null,
      ...extra,
    });

  it('maps an open PR as mergeable', () => {
    const d = run(basePR());
    expect(d.state).toBe('open');
    expect(d.latest_commit?.short_sha).toBe('abcdef1');
    expect(d.latest_commit?.message).toBe('feat: x');
    expect(d.stats).toEqual({ files_changed: 3, additions: 10, deletions: 2 });
    expect(d.merge).toEqual({ mergeable: true, blocked_by: [] });
  });

  it('maps a draft PR as blocked', () => {
    const d = run(basePR({ draft: true }));
    expect(d.state).toBe('draft');
    expect(d.merge.mergeable).toBe(false);
    expect(d.merge.blocked_by.map((b) => b.reason)).toContain('draft');
  });

  it('maps a merged PR', () => {
    const d = run(basePR({ state: 'closed', merged: true }));
    expect(d.state).toBe('merged');
    expect(d.merge.mergeable).toBe(false);
  });

  it('lists every blocking reason including an open parent PR', () => {
    const d = run(basePR({ requested_reviewers: [{ login: 'dan' }] }), {
      checks: [
        { name: 'ci', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
      ],
      reviews: [
        {
          user: { login: 'bob' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '1',
        },
      ],
      parentPr: 5,
    });
    expect(d.parent_pr).toBe(5);
    expect(d.merge.blocked_by).toEqual([
      { reason: 'failing_checks', detail: 'ci' },
      { reason: 'changes_requested', detail: 'bob' },
      { reason: 'pending_reviews', detail: 'dan' },
      { reason: 'blocked_by_parent', detail: '#5' },
    ]);
  });

  it('does not call a PR mergeable while GitHub is still computing', () => {
    const d = run(basePR({ mergeable: null, mergeable_state: 'unknown' }));
    expect(d.merge).toEqual({
      mergeable: false,
      blocked_by: [{ reason: 'mergeability_unknown' }],
    });
  });

  it('ignores failing checks when GitHub says the PR is unstable', () => {
    const d = run(basePR({ mergeable_state: 'unstable' }), {
      checks: [
        { name: 'optional', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(d.merge).toEqual({ mergeable: true, blocked_by: [] });
  });

  it('reports conflicts and unexplained branch protection', () => {
    expect(
      run(basePR({ mergeable: false, mergeable_state: 'dirty' })).merge
        .blocked_by,
    ).toEqual([{ reason: 'conflicts' }]);
    expect(
      run(basePR({ mergeable_state: 'blocked' })).merge.blocked_by,
    ).toEqual([{ reason: 'branch_protection' }]);
  });
});

describe('GET /repos/:source/:owner/:repo/pr/:pr_number', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status });

  // Routes are matched by path suffix, longest suffix first.
  const stubGithub = (routes: Record<string, () => Response>) => {
    const auths: (string | undefined)[] = [];
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        auths.push((init.headers as Record<string, string>).Authorization);
        const key = keys.find((k) => path.endsWith(k));
        return key ? routes[key]() : json({ message: 'nf' }, 404);
      }),
    );
    return auths;
  };

  const get = (
    headers: Record<string, string> = { Authorization: 'Bearer t' },
  ) => app.request('/repos/github/o/r/pr/7', { headers });

  it('401s without a bearer token', async () => {
    const res = await get({});
    expect(res.status).toBe(401);
  });

  it('400s for an unsupported source', async () => {
    const res = await app.request('/repos/gitlab/o/r/pr/7', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ supported: ['github'] });
  });

  it('returns details and forwards the caller token', async () => {
    const auths = stubGithub({
      '/pulls/7': () => json(basePR()),
      '/pulls/7/reviews': () =>
        json([
          { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '1' },
        ]),
      '/pulls/7/commits': () => json([commit]),
      '/check-runs': () => json({ check_runs: [] }),
      '/pulls': () => json([{ number: 5 }]),
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent_pr: number;
      reviewers: unknown;
      merge: { blocked_by: { reason: string }[] };
    };
    expect(body.parent_pr).toBe(5);
    expect(body.reviewers).toEqual([{ login: 'bob', state: 'approved' }]);
    expect(body.merge.blocked_by[0].reason).toBe('blocked_by_parent');
    expect(auths.length).toBe(5);
    expect(auths.every((a) => a === 'Bearer t')).toBe(true);
  });

  it('degrades when checks are inaccessible', async () => {
    stubGithub({
      '/pulls/7': () => json(basePR()),
      '/pulls/7/reviews': () => json([]),
      '/pulls/7/commits': () => json([commit]),
      '/check-runs': () => json({}, 403),
      '/pulls': () => json([]),
    });
    const res = await get();
    expect(res.status).toBe(200);
  });

  it('survives network failures on optional lookups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/check-runs')) throw new Error('network down');
        if (path.endsWith('/pulls')) return json('not json{', 200);
        if (path.endsWith('/pulls/7')) return json(basePR());
        if (path.endsWith('/reviews')) return json([]);
        if (path.endsWith('/commits')) return json([commit]);
        return json({}, 404);
      }),
    );
    expect((await get()).status).toBe(200);
  });

  it('fetches every page of reviews', async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        user: { login: `u${n}-${i}` },
        state: 'APPROVED',
        submitted_at: String(n),
      }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/pulls/7')) return json(basePR());
        if (u.pathname.endsWith('/reviews'))
          return json(
            u.searchParams.get('page') === '1'
              ? page(1)
              : [
                  {
                    user: { login: 'last' },
                    state: 'APPROVED',
                    submitted_at: '2',
                  },
                ],
          );
        if (u.pathname.endsWith('/commits')) return json([commit]);
        if (u.pathname.endsWith('/check-runs')) return json({ check_runs: [] });
        return json([]);
      }),
    );
    const body = (await (await get()).json()) as {
      reviewers: { login: string }[];
    };
    expect(body.reviewers).toHaveLength(101);
    expect(body.reviewers[100]?.login).toBe('last');
  });

  it.each([
    '/pulls/7',
    '/reviews',
    '/commits',
  ])('502s when the required %s lookup throws a network error', async (failing) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith(failing)) throw new TypeError('fetch failed');
        if (path.endsWith('/pulls/7')) return json(basePR());
        if (path.endsWith('/reviews')) return json([]);
        if (path.endsWith('/commits')) return json([commit]);
        if (path.endsWith('/check-runs')) return json({ check_runs: [] });
        return json([]);
      }),
    );
    expect((await get()).status).toBe(502);
  });

  it("502s when the diff route's PR lookup throws a network error", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const res = await app.request('/repos/github/o/r/pr/7/diff', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(502);
  });

  it('forwards Retry-After on rate limiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
      ),
    );
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it.each([
    [401, 401],
    [404, 404],
    [403, 429],
    [429, 429],
    [500, 502],
  ])('maps upstream %i to %i', async (upstream, expected) => {
    stubGithub({ '/pulls/7': () => json({ message: 'x' }, upstream) });
    const res = await get();
    expect(res.status).toBe(expected);
  });

  it('maps a failing reviews call', async () => {
    stubGithub({
      '/pulls/7': () => json(basePR()),
      '/pulls/7/reviews': () => json({}, 500),
      '/pulls/7/commits': () => json([commit]),
      '/check-runs': () => json({ check_runs: [] }),
      '/pulls': () => json([]),
    });
    expect((await get()).status).toBe(502);
  });
});
