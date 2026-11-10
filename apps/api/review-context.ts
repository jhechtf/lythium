import { createHash } from 'node:crypto';
import {
  createDb,
  type ReviewDb,
  type VerifiedPR,
  verifiedPR,
} from '@lythium/db';
import { createMiddleware } from 'hono/factory';

/**
 * Wiring for guided-review state (LYT-60). The API runs without a database:
 * only routes that use `requireReviewDb` need `DATABASE_URL`, and they answer
 * 503 when it isn't set. The connection is opened on first use.
 *
 * Every guided-review route needs two GitHub lookups, which are independent
 * (run them with `Promise.all`):
 * - `resolvePR`: the PR's current head sha, from GitHub with the caller's
 *   token. It is the access check, and the only way to get the `VerifiedPR`
 *   the data layer requires. Never take the head sha from the request.
 * - `fetchViewer`: who the caller is (cached briefly).
 */

let cached: ReviewDb | null | undefined;

export function getReviewDb(): ReviewDb | null {
  if (cached === undefined) {
    const url = process.env.DATABASE_URL;
    cached = url ? createDb(url).db : null;
  }
  return cached;
}

/** Tests: inject a database (e.g. PGlite), or null to simulate none. */
export function setReviewDb(db: ReviewDb | null | undefined) {
  cached = db;
}

export const requireReviewDb = createMiddleware<{
  Variables: { reviewDb: ReviewDb };
}>(async (c, next) => {
  const db = getReviewDb();
  if (!db) {
    return c.json(
      { error: 'Guided review is not configured (DATABASE_URL is not set)' },
      503,
    );
  }
  c.set('reviewDb', db);
  await next();
});

/** GitHub lookups give up after this long, so a slow GitHub can't hang a request. */
export const GITHUB_TIMEOUT_MS = 5000;

type GithubResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      /** Upstream status, 504 on timeout, 502 on a network error. */
      status: number;
    };

async function githubGet(path: string, token: string): Promise<GithubResult> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lythium-api',
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return {
      ok: false,
      status: name === 'TimeoutError' || name === 'AbortError' ? 504 : 502,
    };
  }
}

export interface Viewer {
  id: number;
  login: string;
}

/** How long a token → viewer lookup is reused. Short, so revocation lands fast. */
export const VIEWER_CACHE_TTL_MS = 60_000;
export const VIEWER_CACHE_MAX = 1000;

// Keyed by SHA-256 of the token, never the token itself, so the cache is not
// a store of credentials. Map order is insertion order, so the first key is
// the oldest entry.
const viewerCache = new Map<string, { viewer: Viewer; expires: number }>();

/** Tests: forget cached viewers. */
export function clearViewerCache() {
  viewerCache.clear();
}

/**
 * Identify the caller from their GitHub token via `GET /user`. Review state
 * is keyed by the numeric id (logins can be renamed); the token is never
 * stored. Successful lookups are cached for `VIEWER_CACHE_TTL_MS`.
 */
export async function fetchViewer(
  token: string,
): Promise<{ ok: true; viewer: Viewer } | { ok: false; status: number }> {
  const key = createHash('sha256').update(token).digest('hex');
  const hit = viewerCache.get(key);
  if (hit && hit.expires > Date.now()) return { ok: true, viewer: hit.viewer };
  if (hit) viewerCache.delete(key);

  const result = await githubGet('/user', token);
  if (!result.ok) return result;
  const data = result.data as { id?: unknown; login?: unknown } | null;
  if (typeof data?.id !== 'number' || typeof data.login !== 'string') {
    return { ok: false, status: 502 };
  }
  const viewer = { id: data.id, login: data.login };

  if (viewerCache.size >= VIEWER_CACHE_MAX) {
    const oldest = viewerCache.keys().next().value;
    if (oldest !== undefined) viewerCache.delete(oldest);
  }
  viewerCache.set(key, { viewer, expires: Date.now() + VIEWER_CACHE_TTL_MS });
  return { ok: true, viewer };
}

// GitHub owner/repo names: letters, digits, `-`, `_`, `.` (not `.` or `..`).
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const isName = (s: string) => NAME_RE.test(s) && s !== '.' && s !== '..';

/**
 * Read the PR from GitHub with the caller's token and return it as the
 * `VerifiedPR` the data layer requires. A non-ok result means the caller
 * can't read it (401/403/404 from GitHub), the input was invalid (400), or
 * GitHub failed (429/5xx, 504 on timeout).
 */
export async function resolvePR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ ok: true; pr: VerifiedPR } | { ok: false; status: number }> {
  if (!isName(owner) || !isName(repo)) return { ok: false, status: 400 };
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return { ok: false, status: 400 };
  }
  const result = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    token,
  );
  if (!result.ok) return result;
  const headSha = (result.data as { head?: { sha?: unknown } } | null)?.head
    ?.sha;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return { ok: false, status: 502 };
  }
  return { ok: true, pr: verifiedPR({ owner, repo, prNumber, headSha }) };
}
