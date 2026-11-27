import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import {
  clearInboxCache,
  INBOX_CACHE_MAX,
  INBOX_CACHE_PER_TOKEN_MAX,
  INBOX_CACHE_TTL_MS,
  inboxCacheSize,
  inboxStatuses,
  latestRequestTo,
  MAX_CANDIDATES,
} from './inbox.ts';
import type { InboxFlatResponse, InboxGroupedResponse } from './types.ts';

interface FakePR {
  repo: string;
  number: number;
  title?: string;
  author?: string;
  additions?: number;
  deletions?: number;
  /** Issue comments. */
  comments?: number;
  /** Comment count of each inline review thread. */
  threads?: number[];
  /** Real thread total when more than `threads` were returned. */
  threadsTotal?: number;
  /** Latest opinionated review states, one per reviewer. */
  reviews?: string[];
  /** [reviewer login or null (team), createdAt] review_requested events. */
  requests?: [string | null, string][];
}

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });

interface Call {
  url: string;
  auth: string | null;
  variables?: { scope: string; match: string; hasMatch: boolean };
}
let calls: Call[] = [];

const prNode = (p: FakePR) => ({
  number: p.number,
  title: p.title ?? `PR ${p.number}`,
  url: `https://github.com/${p.repo}/pull/${p.number}`,
  additions: p.additions ?? 1,
  deletions: p.deletions ?? 2,
  author: { login: p.author ?? 'alice' },
  repository: { nameWithOwner: p.repo },
  comments: { totalCount: p.comments ?? 0 },
  reviewThreads: {
    totalCount: p.threadsTotal ?? (p.threads ?? []).length,
    nodes: (p.threads ?? []).map((n) => ({ comments: { totalCount: n } })),
  },
  latestOpinionatedReviews: {
    totalCount: (p.reviews ?? []).length,
    nodes: (p.reviews ?? []).map((state) => ({ state })),
  },
  timelineItems: {
    // `last: 20`: GitHub returns the newest 20 events.
    nodes: (p.requests ?? []).slice(-20).map(([who, at]) => ({
      createdAt: at,
      requestedReviewer: who === null ? {} : { login: who },
    })),
  },
});

/**
 * Stub GitHub's GraphQL endpoint: `scope` PRs are the inbox, `matches` are the
 * hits for the `q` search (any request with `hasMatch`).
 */
function stubGithub(opts: {
  scope: FakePR[];
  matches?: FakePR[];
  viewer?: string;
  /** Reported issueCount of the scope search. */
  scopeCount?: number;
  matchCount?: number;
  /** A node GitHub couldn't return (e.g. SAML-protected org). */
  nullNodeAt?: number;
  /** Errors returned next to data (partial read), or instead of it. */
  errors?: { type?: string; message?: string }[];
  noData?: boolean;
  status?: number;
  headers?: HeadersInit;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        variables?: Call['variables'];
      };
      calls.push({ url, auth, variables: body.variables });
      if (opts.status)
        return json({ message: 'nope' }, opts.status, opts.headers);
      if (opts.noData) return json({ data: null, errors: opts.errors });
      const v = body.variables;
      const scopeNodes: unknown[] = opts.scope.map(prNode);
      if (opts.nullNodeAt !== undefined) scopeNodes[opts.nullNodeAt] = null;
      const matches = opts.matches ?? [];
      return json({
        data: {
          viewer: { login: opts.viewer ?? 'me' },
          scope: {
            issueCount: opts.scopeCount ?? opts.scope.length,
            nodes: scopeNodes,
          },
          ...(v?.hasMatch
            ? {
                matched: {
                  issueCount: opts.matchCount ?? matches.length,
                  nodes: matches.map((m) => ({
                    number: m.number,
                    repository: { nameWithOwner: m.repo },
                  })),
                },
              }
            : {}),
        },
        ...(opts.errors ? { errors: opts.errors } : {}),
      });
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
  vi.unstubAllGlobals();
});

const sample: FakePR[] = [
  {
    repo: 'o/a',
    number: 1,
    comments: 2,
    threads: [1, 2],
    requests: [
      ['me', '2026-01-01T00:00:00Z'],
      ['me', '2026-03-01T00:00:00Z'],
      ['other', '2026-05-01T00:00:00Z'],
      [null, '2026-06-01T00:00:00Z'],
    ],
  },
  {
    repo: 'o/b',
    number: 2,
    reviews: ['APPROVED'],
    requests: [['me', '2026-02-01T00:00:00Z']],
  },
  {
    repo: 'o/a',
    number: 3,
    reviews: ['APPROVED', 'CHANGES_REQUESTED'],
    requests: [['me', '2026-04-01T00:00:00Z']],
  },
  { repo: 'o/b', number: 4 }, // no known request time
];

describe('inbox helpers', () => {
  it("derives independent statuses from each reviewer's latest decision", () => {
    expect(inboxStatuses([])).toEqual(['open']);
    // DISMISSED / COMMENTED are not decisions
    expect(
      inboxStatuses([{ state: 'DISMISSED' }, { state: 'COMMENTED' }]),
    ).toEqual(['open']);
    expect(
      inboxStatuses([{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }]),
    ).toEqual(['changes_requested', 'approved']);
    expect(inboxStatuses([{ state: 'APPROVED' }, {}])).toEqual(['approved']);
  });

  it('picks the latest request aimed at the caller', () => {
    const ev = (who: string | null, at: string) => ({
      createdAt: at,
      requestedReviewer: who === null ? {} : { login: who },
    });
    expect(
      latestRequestTo([ev('Me', '1'), ev('me', '3'), ev('x', '9')], 'me'),
    ).toBe('3');
    expect(latestRequestTo([ev('x', '9'), ev(null, '8')], 'me')).toBeNull();
    // null reviewer / missing fields are ignored safely
    expect(
      latestRequestTo(
        [{ requestedReviewer: null, createdAt: '1' }, {}, { createdAt: 2 }],
        'me',
      ),
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
    // the q search is the mandatory scope plus q, in the same request
    const v = calls[0].variables;
    expect(v?.hasMatch).toBe(true);
    expect(v?.match).toContain('review-requested:@me');
    expect(v?.match).toContain('is:open');
    expect(v?.match.endsWith(' foo')).toBe(true);
    expect(v?.scope).not.toContain('foo');
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

  it('scopes the search to review-requested:@me with the caller token', async () => {
    stubGithub({ scope: sample });
    await get('', 'secret-token');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/graphql');
    expect(calls[0].auth).toBe('Bearer secret-token');
    expect(calls[0].variables).toMatchObject({
      scope: expect.stringContaining('review-requested:@me'),
      hasMatch: false,
    });
    expect(calls[0].variables?.scope).toContain('is:pr is:open');
  });

  it.each([
    ['without q', ''],
    ['with q', '?q=foo'],
  ])(
    'reads a cold 100-PR inbox %s in a bounded number of requests',
    async (_n, qs) => {
      const many: FakePR[] = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
        repo: `o/r${i % 7}`,
        number: i + 1,
        comments: 1,
        threads: [1],
        reviews: ['APPROVED'],
        requests: [
          ['me', `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`],
        ],
      }));
      stubGithub({ scope: many, matches: many.slice(0, 10) });
      const res = await get(qs, 'tok');
      expect(res.status).toBe(200);
      const body = (await res.json()) as InboxFlatResponse;
      expect(body.counts.pending).toBe(MAX_CANDIDATES);
      expect(body.complete).toBe(true);
      // one GraphQL request carries search, metadata and viewer: no per-PR REST
      expect(calls).toHaveLength(1);
      expect(calls.every((c) => c.url.endsWith('/graphql'))).toBe(true);
      expect(
        calls.some((c) => /\/(pulls|issues|reviews|timeline)/.test(c.url)),
      ).toBe(false);
      expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
      expect(calls[0].variables?.hasMatch).toBe(qs !== '');
    },
  );

  it('reuses a fully-read inbox for the same token and q', async () => {
    stubGithub({ scope: sample });
    await get();
    await get();
    expect(calls).toHaveLength(1);
    await get('', 'other-token');
    expect(calls).toHaveLength(2);
    expect(calls[1].auth).toBe('Bearer other-token');
  });

  it('counts inline review comments with issue comments', async () => {
    stubGithub({
      scope: [{ repo: 'o/a', number: 1, comments: 4, threads: [3, 1, 2] }],
    });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items[0].comments).toBe(10);
  });

  it('keeps the latest request to the caller, null when none or unavailable', async () => {
    stubGithub({
      scope: [
        { repo: 'o/a', number: 1, requests: [['me', '2026-01-01T00:00:00Z']] },
        {
          repo: 'o/a',
          number: 2,
          requests: [
            ['x', '2026-05-01T00:00:00Z'],
            [null, '2026-06-01T00:00:00Z'],
          ],
        },
        { repo: 'o/a', number: 3 },
      ],
    });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items.map((i) => [i.number, i.requested_at])).toEqual([
      [1, '2026-01-01T00:00:00Z'],
      [3, null],
      [2, null],
    ]);
  });

  it('marks the inbox incomplete past the read cap', async () => {
    stubGithub({ scope: sample, scopeCount: 500 });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.complete).toBe(false);
    expect(body.items).toHaveLength(4);
  });

  it('marks incomplete when the q search is partial', async () => {
    stubGithub({ scope: sample, matches: [sample[0]], matchCount: 5000 });
    const body = (await (await get('?q=foo')).json()) as InboxFlatResponse;
    expect(body.complete).toBe(false);
  });

  it('drops a PR GitHub could not return and marks the inbox incomplete', async () => {
    stubGithub({
      scope: sample,
      nullNodeAt: 1,
      errors: [{ type: 'FORBIDDEN', message: 'SAML enforcement' }],
    });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items.map((i) => i.number)).not.toContain(2);
    expect(body.counts.pending).toBe(3);
    expect(body.complete).toBe(false);
  });

  it('marks incomplete when a bounded list is cut short', async () => {
    const big: FakePR = {
      repo: 'o/a',
      number: 1,
      reviews: ['APPROVED'],
    };
    stubGithub({ scope: [big] });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, i: RequestInit) => {
      const res = await real(u, i);
      const b = await res.json();
      b.data.scope.nodes[0].latestOpinionatedReviews.totalCount = 500;
      return json(b);
    });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.complete).toBe(false);
  });

  it('does not mark the inbox incomplete for a PR with more than 100 threads', async () => {
    const threads = Array.from({ length: 100 }, () => 2);
    stubGithub({
      scope: [
        {
          repo: 'o/a',
          number: 1,
          comments: 5,
          threads,
          threadsTotal: 350,
          reviews: ['APPROVED'],
        },
        { repo: 'o/b', number: 2 },
      ],
    });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.complete).toBe(true);
    // lower bound: issue comments + the 100 fetched threads
    expect(body.items.find((i) => i.number === 1)?.comments).toBe(205);
    expect(body.items.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(body.counts.pending).toBe(2);
    expect(body.items.find((i) => i.number === 1)?.statuses).toEqual([
      'approved',
    ]);
  });

  it('still marks incomplete when reviews are cut, with or without cut threads', async () => {
    for (const threadsTotal of [undefined, 350]) {
      clearInboxCache();
      stubGithub({
        scope: [
          {
            repo: 'o/a',
            number: 1,
            reviews: ['APPROVED'],
            threads: [1],
            threadsTotal,
          },
        ],
      });
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', async (u: string, i: RequestInit) => {
        const b = await (await real(u, i)).json();
        b.data.scope.nodes[0].latestOpinionatedReviews.totalCount = 500;
        return json(b);
      });
      const body = (await (await get()).json()) as InboxFlatResponse;
      expect(body.complete).toBe(false);
    }
  });

  it('does not cache a partial read: the next load re-reads and recovers', async () => {
    const flaky: FakePR = {
      repo: 'o/a',
      number: 1,
      requests: [['me', '2026-03-01T00:00:00Z']],
    };
    const other: FakePR = {
      repo: 'o/b',
      number: 2,
      requests: [['me', '2026-02-01T00:00:00Z']],
    };
    // first read: the PR's metadata couldn't be returned
    stubGithub({
      scope: [flaky, other],
      nullNodeAt: 0,
      errors: [{ type: 'INTERNAL', message: 'timeout' }],
    });
    const first = (await (await get()).json()) as InboxFlatResponse;
    expect(first.items.map((i) => i.number)).toEqual([2]);
    expect(first.complete).toBe(false);
    expect(calls).toHaveLength(1);

    // recovered, no cache clearing
    stubGithub({ scope: [flaky, other] });
    const second = (await (await get()).json()) as InboxFlatResponse;
    expect(calls).toHaveLength(2);
    expect(second.items[0].number).toBe(1);
    expect(second.items[0].requested_at).toBe('2026-03-01T00:00:00Z');
    expect(second.complete).toBe(true);

    // the recovered read is cached
    await get();
    expect(calls).toHaveLength(2);
  });

  it('still caches a successful read with no request timestamps', async () => {
    stubGithub({ scope: [{ repo: 'o/a', number: 1 }] });
    const first = (await (await get()).json()) as InboxFlatResponse;
    expect(first.items[0].requested_at).toBeNull();
    await get();
    expect(calls).toHaveLength(1);
  });

  it('maps upstream failures', async () => {
    const cases: [Parameters<typeof stubGithub>[0], number][] = [
      [{ scope: sample, status: 401 }, 401],
      [{ scope: sample, status: 403 }, 403],
      [{ scope: sample, status: 429, headers: { 'Retry-After': '30' } }, 429],
      [
        {
          scope: sample,
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'Retry-After': '9' },
        },
        429,
      ],
      [{ scope: sample, status: 404 }, 502],
      [{ scope: sample, status: 500 }, 502],
      [
        { scope: sample, noData: true, errors: [{ type: 'RATE_LIMITED' }] },
        429,
      ],
      [{ scope: sample, noData: true, errors: [{ message: 'boom' }] }, 502],
    ];
    for (const [opts, status] of cases) {
      clearInboxCache();
      stubGithub(opts);
      const res = await get();
      expect(res.status).toBe(status);
      const retry = (opts.headers as Record<string, string> | undefined)?.[
        'Retry-After'
      ];
      if (retry && status === 429)
        expect(res.headers.get('Retry-After')).toBe(retry);
    }
  });

  it('never turns a failed read into an empty inbox', async () => {
    stubGithub({ scope: [], noData: true, errors: [{ message: 'x' }] });
    expect((await get()).status).toBe(502);
    // and a failure is not cached
    stubGithub({ scope: [] });
    const ok = await get();
    expect(ok.status).toBe(200);
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

  it('bounds the whole read by one timed request and recovers after a stall', async () => {
    // The whole inbox is one outbound request carrying a timeout signal, so
    // there is no per-PR fan-out for a deadline to cut off.
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        signals.push(init?.signal);
        throw Object.assign(new Error('stalled'), { name: 'TimeoutError' });
      }),
    );
    expect((await get()).status).toBe(504);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);

    // The timeout isn't cached: the next load re-reads and succeeds.
    stubGithub({ scope: sample });
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
    await get();
    expect(calls).toHaveLength(1);
  });

  describe('cache bounds', () => {
    const load = (token: string, q = '') =>
      get(q ? `?q=${encodeURIComponent(q)}` : '', token);
    const requests = async (fn: () => unknown) => {
      const before = calls.length;
      await fn();
      return calls.length - before;
    };
    afterEach(() => vi.useRealTimers());

    it("keeps one token's query churn within its own cap", async () => {
      stubGithub({ scope: sample, matches: [sample[0]] });
      await load('victim');
      for (let i = 0; i < 40; i++) await load('noisy', `churn${i}`);
      expect(inboxCacheSize()).toBe(1 + INBOX_CACHE_PER_TOKEN_MAX);
      // the other caller's entry survived the churn
      expect(await requests(() => load('victim'))).toBe(0);
      // the noisy token's most recent queries are still warm, older ones gone
      expect(await requests(() => load('noisy', 'churn39'))).toBe(0);
      expect(await requests(() => load('noisy', 'churn0'))).toBe(1);
    });

    it('bounds the whole cache across many tokens', async () => {
      stubGithub({ scope: sample });
      for (let i = 0; i < INBOX_CACHE_MAX + 50; i++) await load(`tok${i}`);
      expect(inboxCacheSize()).toBe(INBOX_CACHE_MAX);
      // oldest tokens went first, newest are warm
      expect(await requests(() => load(`tok${INBOX_CACHE_MAX + 49}`))).toBe(0);
      expect(await requests(() => load('tok0'))).toBe(1);
    });

    it('does not evict an unrelated entry when a key is overwritten at capacity', async () => {
      stubGithub({ scope: sample });
      const per = INBOX_CACHE_PER_TOKEN_MAX;
      const tokens = INBOX_CACHE_MAX / per;
      for (let t = 0; t < tokens; t++)
        for (let i = 0; i < per; i++) await load(`full${t}`, `q${i}`);
      expect(inboxCacheSize()).toBe(INBOX_CACHE_MAX);
      // two concurrent cold loads of the same new key: the second write
      // overwrites the first and must not push anything else out
      await Promise.all([load('fresh', 'x'), load('fresh', 'x')]);
      expect(inboxCacheSize()).toBe(INBOX_CACHE_MAX);
      // exactly one old entry made room: the oldest token's oldest query
      expect(await requests(() => load('full0', 'q1'))).toBe(0);
      expect(await requests(() => load(`full${tokens - 1}`, 'q4'))).toBe(0);
      expect(await requests(() => load('full0', 'q0'))).toBe(1);
    });

    it('treats a read as recent use of its token at the global cap', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      stubGithub({ scope: sample });
      for (let i = 0; i < INBOX_CACHE_MAX; i++) await load(`tok${i}`);
      // the oldest token is read, never written again
      expect(await requests(() => load('tok0'))).toBe(0);
      await load('newcomer');
      expect(inboxCacheSize()).toBe(INBOX_CACHE_MAX);
      // check the survivor before loading the evicted token (which would
      // itself evict something)
      expect(await requests(() => load('tok0'))).toBe(0);
      expect(await requests(() => load('tok1'))).toBe(1);
    });

    it('expires entries after the TTL and serves warm ones before it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      stubGithub({ scope: sample });
      await load('t');
      vi.advanceTimersByTime(INBOX_CACHE_TTL_MS - 1);
      expect(await requests(() => load('t'))).toBe(0);
      vi.advanceTimersByTime(2);
      expect(await requests(() => load('t'))).toBe(1);
      expect(inboxCacheSize()).toBe(1);
    });

    it('drops expired entries before evicting live ones at capacity', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      stubGithub({ scope: sample });
      for (let i = 0; i < INBOX_CACHE_MAX; i++) await load(`old${i}`);
      vi.advanceTimersByTime(INBOX_CACHE_TTL_MS + 1);
      await load('live1');
      await load('live2');
      expect(inboxCacheSize()).toBe(2);
    });
  });

  it('returns an empty inbox', async () => {
    stubGithub({ scope: [] });
    const body = (await (await get()).json()) as InboxFlatResponse;
    expect(body.items).toEqual([]);
    expect(body.counts.pending).toBe(0);
    expect(body.pagination.total_pages).toBe(0);
    expect(body.complete).toBe(true);
  });
});
