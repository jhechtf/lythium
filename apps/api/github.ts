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
 * POST JSON to the GitHub API. Same contract as `githubFetch`: never throws,
 * 504 on timeout, 502 on a network error or unreadable body. A failed write's
 * `data` is GitHub's raw error text (see `githubErrorMessage`). A timeout
 * doesn't mean the write failed: GitHub may still have applied it.
 */
export async function githubPost(
  path: string,
  token: string,
  body: unknown,
  timeoutMs = GITHUB_TIMEOUT_MS,
): Promise<FetchResult> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method: 'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

/** A GraphQL read can scan up to 100 PRs in one call: allow more than REST. */
export const GRAPHQL_TIMEOUT_MS = 20_000;

export interface GraphQLError {
  type?: string;
  message?: string;
}

/**
 * POST a GraphQL query with the caller's token. Never throws. GraphQL answers
 * 200 even for errors, so this maps them: a body with no `data` is a failed
 * result (a `RATE_LIMITED` error → 429, anything else → 502). When `data` is
 * present alongside `errors` the read is partial: `errors` is returned so the
 * caller can treat it as incomplete.
 */
export async function githubGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = GRAPHQL_TIMEOUT_MS,
): Promise<
  | { ok: true; data: Record<string, unknown>; errors: GraphQLError[] }
  | { ok: false; result: FetchResult }
> {
  const result = await githubPost(
    '/graphql',
    token,
    { query, variables },
    timeoutMs,
  );
  if (!result.ok) return { ok: false, result };
  const body = result.data as {
    data?: unknown;
    errors?: unknown;
  } | null;
  const errors = Array.isArray(body?.errors)
    ? (body.errors as GraphQLError[])
    : [];
  const data = body?.data;
  const limited = errors.some((e) => e?.type === 'RATE_LIMITED');
  if (limited || typeof data !== 'object' || data === null) {
    return {
      ok: false,
      result: { ...result, ok: false, status: limited ? 429 : 502 },
    };
  }
  return { ok: true, data: data as Record<string, unknown>, errors };
}

/**
 * GitHub's explanation of a failed request (e.g. a 422's "Can not approve
 * your own pull request"), from its JSON error body: the entries in `errors`
 * if any, else `message`. Null when the body has neither.
 */
export function githubErrorMessage(data: unknown): string | null {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { message, errors } = parsed as { message?: unknown; errors?: unknown };
  if (Array.isArray(errors)) {
    const details = errors
      .map((e) =>
        typeof e === 'string'
          ? e
          : typeof (e as { message?: unknown })?.message === 'string'
            ? (e as { message: string }).message
            : null,
      )
      .filter((m): m is string => !!m);
    if (details.length > 0) return details.join('; ');
  }
  return typeof message === 'string' && message ? message : null;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Fetch every page of a list endpoint (a full page means there may be more),
 * up to `maxPages` × 100 items (default `MAX_PAGES`). Pass `Infinity` when a
 * missing item would give a wrong answer rather than an incomplete one.
 */
export async function githubFetchAll<T>(
  path: string,
  token: string,
  pick: (data: unknown) => T[],
  maxPages = MAX_PAGES,
): Promise<{ ok: true; items: T[] } | { ok: false; result: FetchResult }> {
  const sep = path.includes('?') ? '&' : '?';
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await githubFetch(
      `${path}${sep}per_page=${PAGE_SIZE}&page=${page}`,
      token,
    );
    if (!result.ok) return { ok: false, result };
    const batch = pick(result.data);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return { ok: true, items };
}

/**
 * GitHub answers 403 both for rate limits and for missing permissions. Only
 * the rate-limit kind says so: `x-ratelimit-remaining: 0` (primary) or a
 * `Retry-After` header (secondary).
 */
export const isRateLimited = (
  result: Pick<FetchResult, 'status' | 'headers'>,
) =>
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
