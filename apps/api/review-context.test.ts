import type { ReviewDb } from '@lythium/db';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import {
  clearViewerCache,
  fetchViewer,
  getReviewDb,
  requireReviewDb,
  resolvePR,
  setReviewDb,
  VIEWER_CACHE_TTL_MS,
} from './review-context.ts';

afterEach(() => {
  setReviewDb(undefined);
  clearViewerCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const probe = () =>
  new Hono()
    .use('/guided/*', requireReviewDb)
    .get('/guided/x', (c) => c.json({ hasDb: !!c.get('reviewDb') }));

describe('requireReviewDb', () => {
  it('503s when DATABASE_URL is not set', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await probe().request('/guided/x');
    expect(res.status).toBe(503);
  });

  it('passes the database to the route when configured', async () => {
    setReviewDb({} as ReviewDb);
    const res = await probe().request('/guided/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasDb: true });
  });

  it('does not connect at startup or for existing routes', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const res = await app.request('/repos/github/o/r/pr/7', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(getReviewDb()).toBeNull();
  });
});

describe('fetchViewer', () => {
  it('returns the numeric id and login for the token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, login: 'alice', name: 'A' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchViewer('t')).toEqual({
      ok: true,
      viewer: { id: 42, login: 'alice' },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.github.com/user');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer t',
    );
  });

  it('reports the upstream status on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    expect(await fetchViewer('bad')).toEqual({ ok: false, status: 401 });
  });
});

const userResponse = (id = 42, login = 'alice') =>
  new Response(JSON.stringify({ id, login }));

describe('fetchViewer caching and timeouts', () => {
  it('reuses a lookup for the same token within the TTL', async () => {
    const fetchMock = vi.fn(async () => userResponse());
    vi.stubGlobal('fetch', fetchMock);
    await fetchViewer('t');
    await fetchViewer('t');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('looks up again after the TTL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => userResponse());
    vi.stubGlobal('fetch', fetchMock);
    await fetchViewer('t');
    vi.advanceTimersByTime(VIEWER_CACHE_TTL_MS + 1);
    await fetchViewer('t');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps different tokens apart and does not cache failures', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer bad') return new Response('{}', { status: 401 });
      return auth === 'Bearer a' ? userResponse(1, 'a') : userResponse(2, 'b');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchViewer('a')).toMatchObject({ viewer: { id: 1 } });
    expect(await fetchViewer('b')).toMatchObject({ viewer: { id: 2 } });
    expect(await fetchViewer('bad')).toEqual({ ok: false, status: 401 });
    expect(await fetchViewer('bad')).toEqual({ ok: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('sends a timeout signal and maps a timeout to 504', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        throw new DOMException('timed out', 'TimeoutError');
      }),
    );
    expect(await fetchViewer('t')).toEqual({ ok: false, status: 504 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a network error to 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await fetchViewer('t')).toEqual({ ok: false, status: 502 });
  });
});

describe('resolvePR', () => {
  const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

  it('returns the PR with its head sha from GitHub', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ head: { sha: SHA } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolvePR('t', 'o', 'r', 7)).toEqual({
      ok: true,
      pr: { owner: 'o', repo: 'r', prNumber: 7, headSha: SHA },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/o/r/pulls/7',
    );
  });

  it.each([
    ['..', 'r', 7],
    ['o', 'a/b', 7],
    ['o', 'r', 0],
    ['o', 'r', 1.5],
  ])('rejects %s/%s#%s without calling GitHub', async (owner, repo, n) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolvePR('t', owner, repo, n)).toEqual({
      ok: false,
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes through GitHub denying access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    expect(await resolvePR('t', 'o', 'r', 7)).toEqual({
      ok: false,
      status: 404,
    });
  });

  it('502s on a response without a valid head sha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ head: { sha: 'x' } }))),
    );
    expect(await resolvePR('t', 'o', 'r', 7)).toEqual({
      ok: false,
      status: 502,
    });
  });
});
