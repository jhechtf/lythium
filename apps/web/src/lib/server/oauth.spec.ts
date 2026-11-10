import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  completeLogin,
  createState,
  safeRedirectPath,
  statesMatch,
} from './oauth';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function run(
  query: string,
  fetchImpl: typeof fetch,
  stateCookie: string | null = 'abc',
) {
  return completeLogin({
    params: new URLSearchParams(query),
    stateCookie: stateCookie ?? undefined,
    clientId: 'cid',
    clientSecret: 'super-secret',
    fetch: fetchImpl,
  });
}

describe('safeRedirectPath', () => {
  it.each([
    ['/pr/a/b/1?x=y', '/pr/a/b/1?x=y'],
    ['/', '/'],
    [null, '/'],
    [undefined, '/'],
    ['', '/'],
    ['https://evil.com', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/ok\r\nSet-Cookie: x=1', '/'],
    ['relative/path', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe('state', () => {
  it('generates unique values', () => {
    expect(createState()).not.toBe(createState());
  });

  it('only matches identical non-empty values', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch(undefined, 'abc')).toBe(false);
    expect(statesMatch('abc', null)).toBe(false);
  });

  it('puts client id and state in the authorize url, never a secret', () => {
    const url = new URL(buildAuthorizeUrl('cid', 's1'));
    expect(url.origin + url.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});

describe('completeLogin', () => {
  it('rejects a missing or mismatched state without calling GitHub', async () => {
    const f = vi.fn();
    const forged = await run('code=c&state=nope', f as never);
    const missing = await run('code=c', f as never);
    const noCookie = await run('code=c&state=abc', f as never, null);
    for (const r of [forged, missing, noCookie]) {
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('reports a denied authorization', async () => {
    const f = vi.fn();
    const r = await run('state=abc&error=access_denied', f as never);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(f).not.toHaveBeenCalled();
  });

  it('exchanges the code and verifies the token against /user', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: 'gho_tok', expires_in: 28800 }),
      )
      .mockResolvedValueOnce(json({ login: 'jim' }));
    const r = await run('code=c&state=abc', f as never);

    expect(r).toEqual({ ok: true, token: 'gho_tok', expiresIn: 28800 });
    const [tokenUrl, tokenInit] = f.mock.calls[0];
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(JSON.parse(tokenInit.body)).toEqual({
      client_id: 'cid',
      client_secret: 'super-secret',
      code: 'c',
    });
    const [userUrl, userInit] = f.mock.calls[1];
    expect(userUrl).toBe('https://api.github.com/user');
    expect(userInit.headers.Authorization).toBe('Bearer gho_tok');
  });

  it('treats an invalid or expired code (HTTP 200 + error) as a 400', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(json({ error: 'bad_verification_code' }));
    const r = await run('code=c&state=abc', f as never);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 502 when GitHub is down or the request throws', async () => {
    const down = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const boom = vi.fn().mockRejectedValue(new Error('network'));
    expect(await run('code=c&state=abc', down as never)).toMatchObject({
      ok: false,
      status: 502,
    });
    expect(await run('code=c&state=abc', boom as never)).toMatchObject({
      ok: false,
      status: 502,
    });
  });

  it('rejects a token that /user does not accept', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'gho_tok' }))
      .mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
    const r = await run('code=c&state=abc', f as never);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('never leaks the secret or token in error messages', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'gho_tok' }))
      .mockResolvedValueOnce(json({}, 401));
    const r = await run('code=c&state=abc', f as never);
    expect(JSON.stringify(r)).not.toMatch(/super-secret|gho_tok/);
  });
});
