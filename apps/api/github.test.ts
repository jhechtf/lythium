import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubFetch, localFailure, upstreamError } from './github.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('githubFetch', () => {
  it('sends a timeout signal and maps a timeout to 504', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        throw new DOMException('timed out', 'TimeoutError');
      }),
    );
    expect(await githubFetch('/user', 't')).toMatchObject({
      ok: false,
      status: 504,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a network error to 502 instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await githubFetch('/user', 't')).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});

describe('upstreamError', () => {
  const respond = (status: number, headers?: HeadersInit) =>
    new Hono()
      .get('/', (c) =>
        upstreamError(c, { status, headers: new Headers(headers) }, 7),
      )
      .request('/');

  it.each([
    [401, 401],
    [404, 404],
    [403, 403],
    [429, 429],
    [504, 504],
    [500, 502],
    [400, 502],
  ])('maps upstream %s to %s', async (upstream, expected) => {
    expect((await respond(upstream)).status).toBe(expected);
  });

  it('treats a 403 as a rate limit only when GitHub marks it as one', async () => {
    expect((await respond(403, { 'x-ratelimit-remaining': '0' })).status).toBe(
      429,
    );
    expect(
      (await respond(403, { 'x-ratelimit-remaining': '4999' })).status,
    ).toBe(403);
  });

  it('passes Retry-After through on a rate limit', async () => {
    const res = await respond(403, { 'Retry-After': '30' });
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('accepts a local failure', async () => {
    const res = await new Hono()
      .get('/', (c) => upstreamError(c, localFailure(504), 7))
      .request('/');
    expect(res.status).toBe(504);
  });
});
