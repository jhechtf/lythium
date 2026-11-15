import type { Context } from 'hono';

/**
 * The single boundary for GitHub API calls. Every call uses the caller's
 * token; the service has no credentials of its own. Keep platform-specific
 * requests behind this module (GitLab / Forgejo are planned).
 */

/** Default limit for a GitHub request, so a slow GitHub can't hang a route. */
export const GITHUB_TIMEOUT_MS = 10_000;

export const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'lythium-api',
});

// GitHub owner/repo names: letters, digits, `-`, `_`, `.` (not `.` or `..`).
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Is this a valid GitHub owner or repo name? It guards the path segments
 * interpolated into GitHub URLs, so every route shares this one check.
 */
export const isGithubName = (s: string) =>
  NAME_RE.test(s) && s !== '.' && s !== '..';

export interface FetchResult {
  ok: boolean;
  /** Upstream status, 504 on timeout, 502 on a network error or bad body. */
  status: number;
  data: unknown;
  headers: Headers;
}

/** A failed result that didn't come from GitHub (timeout, network, bad input). */
export const localFailure = (status: number): FetchResult => ({
  ok: false,
  status,
  data: null,
  headers: new Headers(),
});

/**
 * GET from the GitHub API. Never throws: a timeout comes back as 504 and a
 * network error or unreadable body as 502, so callers' `upstreamError`
 * mapping applies instead of Hono's generic 500.
 */
export async function githubFetch(
  path: string,
  token: string,
  timeoutMs = GITHUB_TIMEOUT_MS,
): Promise<FetchResult> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = res.ok ? await res.json() : await res.text();
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return localFailure(
      name === 'TimeoutError' || name === 'AbortError' ? 504 : 502,
    );
  }
}

/**
 * GitHub answers 403 both for rate limits and for missing permissions. Only
 * the rate-limit kind says so: `x-ratelimit-remaining: 0` (primary) or a
 * `Retry-After` header (secondary).
 */
const isRateLimited = (result: Pick<FetchResult, 'status' | 'headers'>) =>
  result.status === 429 ||
  (result.status === 403 &&
    (result.headers.get('x-ratelimit-remaining') === '0' ||
      result.headers.has('Retry-After')));

/**
 * Map a failed GitHub result to the API's error response: 401 → 401,
 * 404 → 404, a rate limit (429, or a 403 marked as one) → 429 with
 * `Retry-After`, any other 403 → 403 (a missing permission; retrying won't
 * help), timeout → 504, anything else → 502.
 */
export function upstreamError(
  c: Context,
  result: Pick<FetchResult, 'status' | 'headers'>,
  prNumber: string | number,
) {
  if (result.status === 401)
    return c.json({ error: 'GitHub authentication failed' }, 401);
  if (result.status === 404)
    return c.json({ error: `PR #${prNumber} not found` }, 404);
  if (result.status === 403 && !isRateLimited(result)) {
    // Retrying won't help: the token lacks a permission (e.g. Checks: read).
    return c.json({ error: 'GitHub denied access to this resource' }, 403);
  }
  if (isRateLimited(result)) {
    const retryAfter = result.headers.get('Retry-After');
    if (retryAfter) c.header('Retry-After', retryAfter);
    return c.json({ error: 'GitHub rate limit exceeded', retryAfter }, 429);
  }
  if (result.status === 504)
    return c.json({ error: 'GitHub did not respond in time' }, 504);
  return c.json({ error: 'GitHub API error' }, 502);
}
