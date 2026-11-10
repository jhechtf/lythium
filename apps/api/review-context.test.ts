import type { ReviewDb } from '@lythium/db';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import {
  fetchViewer,
  getReviewDb,
  requireReviewDb,
  setReviewDb,
} from './review-context.ts';

afterEach(() => {
  setReviewDb(undefined);
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
