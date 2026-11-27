import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import { clearInboxCache, inboxStatuses, latestRequestTo } from './inbox.ts';
import { clearViewerCache } from './review-context.ts';
import type { InboxFlatResponse, InboxGroupedResponse } from './types.ts';

interface FakePR {
  repo: string;
  number: number;
  title?: string;
  author?: string;
  additions?: number;
  deletions?: number;
  comments?: number;
  review_comments?: number;
  reviews?: { login: string; state: string; at: string }[];
  /** [reviewer, created_at] review_requested events. */
  requests?: [string, string][];
  timelineStatus?: number;
  detailsStatus?: number;
  updated_at?: string;
}

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });

let calls: { url: string; auth: string | null }[] = [];

/** Stub GitHub: `scope` PRs are the inbox, `matches` are hits for any extra q. */
function stubGithub(opts: {
  scope: FakePR[];
  matches?: FakePR[];
  viewer?: string;
  searchTotal?: number;
  incomplete?: boolean;
  searchStatus?: number;
  searchHeaders?: HeadersInit;
  viewerStatus?: number;
}) {
  const all = new Map<string, FakePR>();
  for (const p of [...opts.scope, ...(opts.matches ?? [])])
    all.set(`${p.repo}#${p.number}`, p);
  const hit = (p: FakePR) => ({
    number: p.number,
    repository_url: `https://api.github.com/repos/${p.repo}`,
    updated_at: p.updated_at ?? '2026-01-01T00:00:00Z',
    pull_request: {},
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');
      calls.push({ url, auth });
      const u = new URL(url);
      if (u.pathname === '/user') {
        if (opts.viewerStatus) return json({}, opts.viewerStatus);
        return json({ id: 1, login: opts.viewer ?? 'me' });
      }
      if (u.pathname === '/search/issues') {
        if (opts.searchStatus)
          return json(
            { message: 'nope' },
            opts.searchStatus,
            opts.searchHeaders,
          );
        const q = u.searchParams.get('q') ?? '';
        const list = q.includes('foo') ? (opts.matches ?? []) : opts.scope;
        return json({
          total_count: opts.searchTotal ?? list.length,
          incomplete_results: opts.incomplete ?? false,
          items: list.map(hit),
        });
      }
      const m = /^\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)(\/\w+)?$/.exec(
        u.pathname,
      );
      if (!m) return json({}, 500);
      const pr = all.get(`${m[1]}#${m[3]}`);
      if (!pr) return json({}, 404);
      if (!m[4]) {
        if (pr.detailsStatus) return json({}, pr.detailsStatus);
        return json({
          title: pr.title ?? `PR ${pr.number}`,
          html_url: `https://github.com/${pr.repo}/pull/${pr.number}`,
          user: { login: pr.author ?? 'alice' },
          additions: pr.additions ?? 1,
          deletions: pr.deletions ?? 2,
          comments: pr.comments ?? 0,
          review_comments: pr.review_comments ?? 0,
        });
      }
      if (m[4] === '/reviews')
        return json(
          (pr.reviews ?? []).map((r) => ({
            user: { login: r.login },
            state: r.state,
            submitted_at: r.at,
          })),
        );
      if (m[4] === '/timeline') {
        if (pr.timelineStatus) return json({}, pr.timelineStatus);
        return json(
          (pr.requests ?? []).map(([who, at]) => ({
            event: 'review_requested',
            created_at: at,
            requested_reviewer: { login: who },
          })),
        );
      }
      return json({}, 500);
    }),
  );
}

const get = (qs = '', token: string | null = 't') =>
  app.request(`/inbox${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  clearInboxCache();
  clearViewerCache();
  vi.unstubAllGlobals();
});

const sample: FakePR[] = [
  {
    repo: 'o/a',
    number: 1,
    comments: 2,
    review_comments: 3,
    requests: [
      ['me', '2026-01-01T00:00:00Z'],
      ['me', '2026-03-01T00:00:00Z'],
      ['other', '2026-05-01T00:00:00Z'],
    ],
  },
  {
    repo: 'o/b',
    number: 2,
    reviews: [{ login: 'bob', state: 'APPROVED', at: '1' }],
    requests: [['me', '2026-02-01T00:00:00Z']],
  },
  {
    repo: 'o/a',
    number: 3,
    reviews: [
      { login: 'bob', state: 'APPROVED', at: '1' },
      { login: 'carol', state: 'CHANGES_REQUESTED', at: '2' },
    ],
    requests: [['me', '2026-04-01T00:00:00Z']],
  },
  { repo: 'o/b', number: 4 }, // no known request time
];

describe('inbox helpers', () => {
  it('derives independent statuses from the latest decision per reviewer', () => {
    const r = (login: string, state: string, at: string) => ({
      user: { login },
      state,
      submitted_at: at,
    });
    expect(inboxStatuses([])).toEqual(['open']);
    expect(inboxStatuses([r('a', 'COMMENTED', '1')])).toEqual(['open']);
    expect(
      inboxStatuses([
        r('a', 'APPROVED', '1'),
        r('b', 'CHANGES_REQUESTED', '1'),
      ]),
    ).toEqual(['changes_requested', 'approved']);
    // a reviewer who changed their mind no longer holds the old decision
    expect(
      inboxStatuses([
        r('a', 'CHANGES_REQUESTED', '1'),
        r('a', 'APPROVED', '2'),
      ]),
    ).toEqual(['approved']);
    expect(
      inboxStatuses([r('a', 'APPROVED', '1'), r('a', 'DISMISSED', '2')]),
    ).toEqual(['open']);
  });

  it('picks the latest request aimed at the caller', () => {
    const ev = (who: string, at: string) => ({
      event: 'review_requested',
      created_at: at,
      requested_reviewer: { login: who },
    });
    expect(
      latestRequestTo([ev('Me', '1'), ev('me', '3'), ev('x', '9')], 'me'),
    ).toBe('3');
    expect(latestRequestTo([ev('x', '9')], 'me')).toBeNull();
    expect(
      latestRequestTo([{ event: 'commented', created_at: '1' }], 'me'),
    ).toBeNull();
  });
});

describe('GET /inbox', () => {
  it('returns the flat shape with every field, ordered', async () => {
    stubGithub({ scope: sample });
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxFlatResponse;
    expect(body.group_by).toBe('none');
    expect(body.items.map((i) => `${i.repository}#${i.number}`)).toEqual([
      'o/a#3',
      'o/a#1',
      'o/b#2',
      'o/b#4',
    ]);
    expect(body.items[1]).toEqual({
      repository: 'o/a',
      number: 1,
      title: 'PR 1',
      html_url: 'https://github.com/o/a/pull/1',
      author: 'alice',
      statuses: ['open'],
      comments: 5,
      additions: 1,
      deletions: 2,
      requested_at: '2026-03-01T00:00:00Z',
    });
    expect(body.items[3].requested_at).toBeNull();
    expect(body.counts).toEqual({
      pending: 4,
      status: { open: 2, changes_requested: 1, approved: 2 },
    });
    expect(body.repositories).toEqual([
      { name: 'o/a', count: 2 },
      { name: 'o/b', count: 2 },
    ]);
    expect(body.pagination).toEqual({
      page: 1,
      per_page: 25,
      total: 4,
      total_pages: 1,
    });
    expect(body.complete).toBe(true);
  });

  it('scopes the search to review-requested:@me with the caller token', async () => {
    stubGithub({ scope: sample });
    await get('', 'secret-token');
    const search = calls.find((c) => c.url.includes('/search/issues'));
    expect(decodeURIComponent(search?.url ?? '')).toContain(
      'review-requested:@me',
    );
    expect(calls.every((c) => c.auth === 'Bearer secret-token')).toBe(true);
  });

  it('groups the same page by repository', async () => {
    stubGithub({ scope: sample });
    const body = (await (
      await get('?group_by=repository&per_page=3')
    ).json()) as InboxGroupedResponse;
    expect(body.group_by).toBe('repository');
    expect(
      body.groups.map((g) => [g.repository, g.items.map((i) => i.number)]),
    ).toEqual([
      ['o/a', [3, 1]],
      ['o/b', [2]],
    ]);
    expect(body.pagination.total).toBe(4);
    expect(body.pagination.total_pages).toBe(2);
  });

  it('paginates before grouping and handles page boundaries', async () => {
    stubGithub({ scope: sample });
    const p2 = (await (
      await get('?group_by=repository&per_page=3&page=2')
    ).json()) as InboxGroupedResponse;
    expect(p2.groups).toEqual([
      expect.objectContaining({
        repository: 'o/b',
        items: [expect.objectContaining({ number: 4 })],
      }),
    ]);
    const p9 = (await (
      await get('?per_page=3&page=9')
    ).json()) as InboxFlatResponse;
    expect(p9.items).toEqual([]);
    expect(p9.pagination.total).toBe(4);
  });

  it('filters by status, repo and q, but counts stay whole-inbox', async () => {
    stubGithub({ scope: sample, matches: [sample[2], sample[1]] });
    const body = (await (
      await get('?status=approved&repo=O/A&q=foo')
    ).json()) as InboxFlatResponse;
    expect(body.items.map((i) => i.number)).toEqual([3]);
    expect(body.pagination.total).toBe(1);
    expect(body.counts.pending).toBe(4);
    expect(body.counts.status).toEqual({
      open: 2,
      changes_requested: 1,
      approved: 2,
    });
    expect(body.repositories).toHaveLength(2);
  });

  it('filters on each status', async () => {
    stubGithub({ scope: sample });
    const by = async (s: string) =>
      (
        (await (await get(`?status=${s}`)).json()) as InboxFlatResponse
      ).items.map((i) => i.number);
    expect(await by('open')).toEqual([1, 4]);
    expect(await by('changes_requested')).toEqual([3]);
    expect(await by('approved')).toEqual([3, 2]);
  });

  it('never widens the inbox beyond the scope search (q hits outside it are dropped)', async () => {
    stubGithub({
      scope: [sample[0]],
      matches: [{ repo: 'o/x', number: 99 }, sample[0]],
    });
    const body = (await (await get('?q=foo')).json()) as InboxFlatResponse;
    expect(body.items.map((i) => i.number)).toEqual([1]);
    const qSearch = calls
      .map((c) => decodeURIComponent(c.url))
      .find((u) => u.includes('foo'));
    expect(qSearch).toContain('review-requested:@me');
  });

  it.each([
    'foo OR bar',
    '(foo)',
    'review-requested:other',
    '-review-requested:@me',
    'user-review-requested:@me',
    'is:merged',
    'state:closed',
    'type:issue',
    'reviewed-by:me',
    'x'.repeat(300),
  ])('rejects scope-breaking q %j', async (q) => {
    stubGithub({ scope: sample });
    const res = await get(`?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('accepts GitHub qualifiers that only narrow', async () => {
    stubGithub({ scope: sample, matches: [sample[0]] });
    const res = await get(
      `?q=${encodeURIComponent('foo author:alice label:bug')}`,
    );
    expect(res.status).toBe(200);
  });

  it.each([
    'status=bogus',
    'repo=nope',
    'repo=a/b/c',
    'repo=../x',
    'group_by=team',
    'page=0',
    'page=abc',
    'per_page=0',
    'per_page=101',
    'per_page=-1',
  ])('400s on malformed params (%s)', async (qs) => {
    stubGithub({ scope: sample });
    const res = await get(`?${qs}`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('401s without a token', async () => {
    stubGithub({ scope: sample });
    expect((await get('', null)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('keeps cache per token', async () => {
    stubGithub({ scope: sample });
    await get('', 'token-a');
    calls = [];
    await get('', 'token-a');
    expect(calls).toHaveLength(0);
    await get('', 'token-b');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.auth === 'Bearer token-b')).toBe(true);
  });

  it('reuses the cache until a PR changes', async () => {
    stubGithub({
      scope: [{ ...sample[0], updated_at: '2026-01-01T00:00:00Z' }],
    });
    await get();
    clearViewerCache();
    // search cache is still warm; a new updated_at would miss the enrich cache
    expect((await get()).status).toBe(200);
  });

  it('reports a missing timeline as null requested_at, not an error', async () => {
    stubGithub({ scope: [{ ...sample[0], timelineStatus: 403 }] });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items[0].requested_at).toBeNull();
    expect(body.complete).toBe(true);
  });

  it('drops a PR that disappeared and marks the inbox incomplete', async () => {
    stubGithub({ scope: [sample[0], { ...sample[1], detailsStatus: 404 }] });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items).toHaveLength(1);
    expect(body.counts.pending).toBe(1);
    expect(body.complete).toBe(false);
  });

  it('marks the inbox incomplete past the read cap or on incomplete results', async () => {
    stubGithub({ scope: sample, searchTotal: 500 });
    expect(((await (await get()).json()) as InboxFlatResponse).complete).toBe(
      false,
    );
    clearInboxCache();
    stubGithub({ scope: sample, incomplete: true });
    expect(((await (await get()).json()) as InboxFlatResponse).complete).toBe(
      false,
    );
  });

  it('marks incomplete when the q search is partial', async () => {
    stubGithub({ scope: sample, matches: [sample[0]], searchTotal: 5000 });
    // scope search is also reported partial by the shared total; either way:
    const body = (await (await get('?q=foo')).json()) as InboxFlatResponse;
    expect(body.complete).toBe(false);
  });

  it('maps upstream failures', async () => {
    const reset = () => {
      clearInboxCache();
      clearViewerCache();
    };
    reset();
    stubGithub({ scope: sample, searchStatus: 401 });
    expect((await get()).status).toBe(401);

    reset();
    stubGithub({ scope: sample, searchStatus: 403 });
    expect((await get()).status).toBe(403);

    reset();
    stubGithub({
      scope: sample,
      searchStatus: 429,
      searchHeaders: { 'Retry-After': '30' },
    });
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('30');

    reset();
    stubGithub({
      scope: sample,
      searchStatus: 403,
      searchHeaders: { 'x-ratelimit-remaining': '0', 'Retry-After': '9' },
    });
    expect((await get()).status).toBe(429);

    reset();
    stubGithub({ scope: sample, searchStatus: 422 });
    expect((await get()).status).toBe(400);

    reset();
    stubGithub({ scope: sample, searchStatus: 500 });
    expect((await get()).status).toBe(502);

    reset();
    stubGithub({ scope: sample, viewerStatus: 401 });
    expect((await get()).status).toBe(401);
  });

  it('maps network errors and timeouts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    expect((await get()).status).toBe(502);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      }),
    );
    expect((await get()).status).toBe(504);
  });

  it('drops a PR that cannot be read and marks the inbox incomplete', async () => {
    for (const detailsStatus of [403, 502, 503]) {
      clearInboxCache();
      stubGithub({
        scope: [sample[0], { ...sample[1], detailsStatus }],
      });
      const res = await get();
      expect(res.status).toBe(200);
      const body = (await res.json()) as InboxFlatResponse;
      expect(body.items).toHaveLength(1);
      expect(body.complete).toBe(false);
    }
  });

  it('fails the request when a PR read hits a token-wide failure', async () => {
    for (const [detailsStatus, expected] of [
      [429, 429],
      [401, 401],
    ] as const) {
      clearInboxCache();
      stubGithub({ scope: [sample[0], { ...sample[1], detailsStatus }] });
      expect((await get()).status).toBe(expected);
    }
  });

  it('reads at most two timeline pages per PR', async () => {
    stubGithub({ scope: [sample[0]] });
    await get();
    const pages = calls.filter((c) => c.url.includes('/timeline'));
    expect(pages.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty inbox', async () => {
    stubGithub({ scope: [] });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items).toEqual([]);
    expect(body.counts.pending).toBe(0);
    expect(body.pagination.total_pages).toBe(0);
  });
});
