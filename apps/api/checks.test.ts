import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import {
  buildPRChecks,
  type GithubCheckRunFull,
  type GithubCommitStatus,
  mapCheckRunState,
  mapStatusState,
} from './checks.ts';

const run = (over: Partial<GithubCheckRunFull> = {}): GithubCheckRunFull => ({
  id: 1,
  name: 'ci',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-01-01T00:00:00Z',
  completed_at: '2026-01-01T00:01:30Z',
  html_url: 'https://github.com/o/r/runs/1',
  details_url: 'https://ci.example/1',
  ...over,
});

const status = (
  over: Partial<GithubCommitStatus> = {},
): GithubCommitStatus => ({
  context: 'legacy/ci',
  state: 'success',
  target_url: 'https://legacy.example/1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:02:00Z',
  ...over,
});

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

describe('mapCheckRunState', () => {
  it.each([
    ['queued', null, 'running'],
    ['in_progress', null, 'running'],
    ['completed', 'success', 'passed'],
    ['completed', 'neutral', 'passed'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'stale', 'skipped'],
    ['completed', 'failure', 'failed'],
    ['completed', 'timed_out', 'failed'],
    ['completed', 'cancelled', 'failed'],
    ['completed', 'action_required', 'failed'],
    ['completed', 'startup_failure', 'failed'],
  ] as const)('%s/%s → %s', (s, conclusion, expected) => {
    expect(mapCheckRunState(s, conclusion)).toBe(expected);
  });
});

describe('mapStatusState', () => {
  it.each([
    ['pending', 'running'],
    ['success', 'passed'],
    ['failure', 'failed'],
    ['error', 'failed'],
  ] as const)('%s → %s', (s, expected) => {
    expect(mapStatusState(s)).toBe(expected);
  });
});

describe('buildPRChecks', () => {
  it('counts a mixed PR and reports failed overall', () => {
    const out = buildPRChecks({
      headSha: SHA,
      checkRuns: [
        run({ id: 1, name: 'a' }),
        run({ id: 2, name: 'b' }),
        run({
          id: 3,
          name: 'c',
          status: 'in_progress',
          conclusion: null,
          completed_at: null,
        }),
        run({ id: 4, name: 'd', conclusion: 'failure' }),
        run({ id: 5, name: 'e', conclusion: 'skipped' }),
      ],
      statuses: [
        status({ context: 'f' }),
        status({ context: 'g', state: 'pending' }),
      ],
    });
    expect(out.state).toBe('failed');
    expect(out.counts).toEqual({
      passed: 3,
      running: 2,
      failed: 1,
      skipped: 1,
    });
    expect(out.total).toBe(7);
  });

  it('is running when nothing failed but something is in progress', () => {
    const out = buildPRChecks({
      headSha: SHA,
      checkRuns: [
        run(),
        run({ id: 2, status: 'queued', conclusion: null, started_at: null }),
      ],
      statuses: [],
    });
    expect(out.state).toBe('running');
  });

  it('is passed when everything passed or was skipped', () => {
    const out = buildPRChecks({
      headSha: SHA,
      checkRuns: [run(), run({ id: 2, conclusion: 'skipped' })],
      statuses: [],
    });
    expect(out.state).toBe('passed');
  });

  it('is none when the PR has no checks', () => {
    const out = buildPRChecks({ headSha: SHA, checkRuns: [], statuses: [] });
    expect(out.state).toBe('none');
    expect(out.total).toBe(0);
    expect(out.build).toEqual({
      sha: SHA,
      short_sha: 'abcdef1',
      started_at: null,
      completed_at: null,
    });
  });

  it('computes durations and leaves them null while running', () => {
    const out = buildPRChecks({
      headSha: SHA,
      checkRuns: [
        run({ name: 'done' }),
        run({
          id: 2,
          name: 'busy',
          status: 'in_progress',
          conclusion: null,
          completed_at: null,
        }),
      ],
      statuses: [],
    });
    const byName = Object.fromEntries(out.checks.map((c) => [c.name, c]));
    expect(byName.done.duration_seconds).toBe(90);
    expect(byName.busy.duration_seconds).toBeNull();
    expect(byName.busy.completed_at).toBeNull();
  });

  it('shapes check runs and commit statuses', () => {
    const out = buildPRChecks({
      headSha: SHA,
      checkRuns: [run()],
      statuses: [status()],
    });
    expect(out.checks).toEqual([
      {
        name: 'ci',
        source: 'check_run',
        status: 'completed',
        conclusion: 'success',
        state: 'passed',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:01:30Z',
        duration_seconds: 90,
        url: 'https://github.com/o/r/runs/1',
      },
      {
        name: 'legacy/ci',
        source: 'status',
        status: 'completed',
        conclusion: 'success',
        state: 'passed',
        started_at: null,
        completed_at: '2026-01-01T00:02:00Z',
        duration_seconds: null,
        url: 'https://legacy.example/1',
      },
    ]);
  });

  it('reports a pending status as in progress with no conclusion', () => {
    const [c] = buildPRChecks({
      headSha: SHA,
      checkRuns: [],
      statuses: [status({ state: 'pending' })],
    }).checks;
    expect(c).toMatchObject({
      status: 'in_progress',
      conclusion: null,
      state: 'running',
      completed_at: null,
    });
  });

  it('falls back to details_url when html_url is missing', () => {
    const [c] = buildPRChecks({
      headSha: SHA,
      checkRuns: [run({ html_url: null })],
      statuses: [],
    }).checks;
    expect(c.url).toBe('https://ci.example/1');
  });

  it('spans the build from first start to last finish, open while running', () => {
    const done = buildPRChecks({
      headSha: SHA,
      checkRuns: [
        run({
          started_at: '2026-01-01T00:00:10Z',
          completed_at: '2026-01-01T00:05:00Z',
        }),
        run({
          id: 2,
          started_at: '2026-01-01T00:00:00Z',
          completed_at: '2026-01-01T00:03:00Z',
        }),
      ],
      statuses: [],
    });
    expect(done.build.started_at).toBe('2026-01-01T00:00:00Z');
    expect(done.build.completed_at).toBe('2026-01-01T00:05:00Z');

    const busy = buildPRChecks({
      headSha: SHA,
      checkRuns: [
        run(),
        run({
          id: 2,
          status: 'in_progress',
          conclusion: null,
          completed_at: null,
        }),
      ],
      statuses: [],
    });
    expect(busy.build.completed_at).toBeNull();
  });
});

describe('GET /repos/:source/:owner/:repo/pr/:pr_number/checks', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status });

  const pr = { number: 7, head: { sha: SHA } };

  const stubGithub = (
    routes: Record<string, (u: URL) => Response | Promise<Response>>,
  ) => {
    const calls: { path: string; auth?: string }[] = [];
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        calls.push({
          path: u.pathname,
          auth: (init.headers as Record<string, string>).Authorization,
        });
        const key = keys.find((k) => u.pathname.endsWith(k));
        return key ? routes[key](u) : json({ message: 'nf' }, 404);
      }),
    );
    return calls;
  };

  const get = (
    headers: Record<string, string> = { Authorization: 'Bearer t' },
    path = '/repos/github/o/r/pr/7/checks',
  ) => app.request(path, { headers });

  it('401s without a bearer token', async () => {
    expect((await get({})).status).toBe(401);
  });

  it('400s for an unsupported source', async () => {
    const res = await get(undefined, '/repos/gitlab/o/r/pr/7/checks');
    expect(res.status).toBe(400);
  });

  it('combines check runs and statuses for the head sha', async () => {
    const calls = stubGithub({
      '/pulls/7': () => json(pr),
      [`/commits/${SHA}/check-runs`]: () =>
        json({ total_count: 1, check_runs: [run()] }),
      [`/commits/${SHA}/status`]: () =>
        json({ state: 'success', statuses: [status()] }),
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      total: number;
      build: { sha: string };
    };
    expect(body.state).toBe('passed');
    expect(body.total).toBe(2);
    expect(body.build.sha).toBe(SHA);
    expect(calls.every((c) => c.auth === 'Bearer t')).toBe(true);
  });

  it('fetches every page of check runs', async () => {
    stubGithub({
      '/pulls/7': () => json(pr),
      '/check-runs': (u) =>
        json({
          check_runs:
            u.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, i) =>
                  run({ id: i, name: `c${i}` }),
                )
              : [run({ id: 100, name: 'last', conclusion: 'failure' })],
        }),
      '/status': () => json({ statuses: [] }),
    });
    const body = (await (await get()).json()) as {
      total: number;
      state: string;
    };
    expect(body.total).toBe(101);
    expect(body.state).toBe('failed');
  });

  it('fetches the remaining check-run pages in parallel using total_count', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pagesRequested: string[] = [];
    stubGithub({
      '/pulls/7': () => json(pr),
      '/check-runs': async (u) => {
        const page = u.searchParams.get('page') ?? '';
        pagesRequested.push(page);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        const size = page === '3' ? 50 : 100;
        return json({
          total_count: 250,
          check_runs: Array.from({ length: size }, (_, i) =>
            run({ id: Number(page) * 1000 + i, name: `p${page}-${i}` }),
          ),
        });
      },
      '/status': () => json({ total_count: 0, statuses: [] }),
    });
    const body = (await (await get()).json()) as { total: number };
    expect(body.total).toBe(250);
    expect(pagesRequested.sort()).toEqual(['1', '2', '3']);
    expect(maxInFlight).toBe(2); // pages 2 and 3 together
  });

  it.each([
    ['/repos/github/o/r/pr/..%2F..%2F..%2F..%2Fuser/checks', 400],
    ['/repos/github/o/r/pr/abc/checks', 400],
    ['/repos/github/o/r/pr/0/checks', 400],
    ['/repos/github/o%2F..%2F..%2Fuser/r/pr/7/checks', 400],
    ['/repos/github/o/r%3Fx%3D1/pr/7/checks', 400],
    // The URL parser resolves `..` (also `%2E%2E`) before routing, so these
    // never match the route; the handler's name check is a second layer.
    ['/repos/github/%2E%2E/r/pr/7/checks', 404],
  ] as const)('rejects %s with %i and never calls GitHub', async (path, status) => {
    const calls = stubGithub({});
    const res = await get(undefined, path);
    expect(res.status).toBe(status);
    expect(calls).toEqual([]);
  });

  it('502s instead of crashing when the PR response has no head sha', async () => {
    stubGithub({ '/pulls/7': () => json({ message: 'not a PR' }) });
    expect((await get()).status).toBe(502);
  });

  it('still returns check runs when statuses are inaccessible', async () => {
    stubGithub({
      '/pulls/7': () => json(pr),
      '/check-runs': () => json({ check_runs: [run()] }),
      '/status': () => {
        throw new Error('network down');
      },
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(1);
  });

  it('maps a failing check-runs call', async () => {
    stubGithub({
      '/pulls/7': () => json(pr),
      '/check-runs': () => json({}, 500),
      '/status': () => json({ statuses: [] }),
    });
    expect((await get()).status).toBe(502);
  });

  it.each([
    [401, 401],
    [404, 404],
    [403, 429],
    [500, 502],
  ])('maps upstream %i on the PR to %i', async (upstream, expected) => {
    stubGithub({ '/pulls/7': () => json({ message: 'x' }, upstream) });
    expect((await get()).status).toBe(expected);
  });
});
