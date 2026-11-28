import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';

vi.mock('$app/env/private', () => ({ API_URL: 'http://api.test' }));

const inbox = {
  group_by: 'none',
  items: [],
  counts: {
    pending: 0,
    status: { open: 0, approved: 0, changes_requested: 0 },
  },
  repositories: [],
  pagination: { page: 1, per_page: 25, total: 0, total_pages: 0 },
  complete: true,
};

const run = (search: string, fetch: typeof globalThis.fetch, token?: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: partial load event
  (load as any)({
    url: new URL(`http://web.test/${search}`),
    cookies: { get: () => token },
    fetch,
  });

const reply = (status: number, body: unknown = {}, headers = {}) =>
  vi.fn(async () => Response.json(body, { status, headers }));

describe('inbox load', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('redirects to OAuth with a relative return path when signed out', async () => {
    const fetch = reply(200);
    const err = await run('?status=approved&page=2', fetch).catch(
      (e: unknown) => e as { location: string },
    );
    expect(isRedirect(err)).toBe(true);
    expect(err.location).toBe(
      `/auth/github/login?redirectTo=${encodeURIComponent('/?status=approved&page=2')}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards defaults and the bearer token only', async () => {
    const fetch = reply(200, inbox);
    const data = await run('', fetch, 'secret');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/inbox?group_by=none&page=1');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(data.inbox).toEqual(inbox);
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('forwards only allowlisted, valid params', async () => {
    const fetch = reply(200, inbox);
    await run(
      '?status=approved&repo=a/b&q=%20bug%20&group_by=repository&page=3&per_page=999&evil=1',
      fetch,
      't',
    );
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'approved',
      repo: 'a/b',
      q: 'bug',
      group_by: 'repository',
      page: '3',
    });
  });

  it('drops invalid status, group and page values', async () => {
    const fetch = reply(200, inbox);
    await run('?status=nope&group_by=author&page=-2', fetch, 't');
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      group_by: 'none',
      page: '1',
    });
  });

  it('passes a grouped, partial response through', async () => {
    const grouped = {
      ...inbox,
      group_by: 'repository',
      groups: [],
      complete: false,
    };
    const data = await run('?group_by=repository', reply(200, grouped), 't');
    expect(data.inbox.group_by).toBe('repository');
    expect(data.inbox.complete).toBe(false);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [502, 'unavailable'],
    [504, 'unavailable'],
    [500, 'unavailable'],
  ])('maps API %i to %s', async (status, kind) => {
    const data = await run(
      '',
      reply(status, { error: 'boom token=secret' }),
      't',
    );
    expect(data.inbox).toBeNull();
    expect(data.failure.kind).toBe(kind);
    expect(data.failure.message).not.toContain('secret');
  });

  it('surfaces the API message for a 400', async () => {
    const data = await run(
      '?q=OR',
      reply(400, { error: 'q may not use OR' }),
      't',
    );
    expect(data.failure).toEqual({
      kind: 'invalid',
      message: 'q may not use OR',
    });
  });

  it('reports retry-after for a 429', async () => {
    const data = await run('', reply(429, {}, { 'retry-after': '30' }), 't');
    expect(data.failure).toMatchObject({ kind: 'rate_limit', retryAfter: 30 });
  });

  it('handles a network failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('down'));
    const data = await run('', fetch, 't');
    expect(data.failure.kind).toBe('unavailable');
  });
});
