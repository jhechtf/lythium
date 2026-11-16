import { createHash } from 'node:crypto';
import {
  createDb,
  type EditablePR,
  editablePR,
  type ReviewDb,
  type VerifiedPR,
  verifiedPR,
} from '@lythium/db';
import { createMiddleware } from 'hono/factory';
import {
  type FetchResult,
  githubFetch,
  isGithubName,
  localFailure,
} from './github.ts';

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
 *
 * Reading a PR is enough to read its groups and set your own reviewed/viewed
 * marks. Changing the shared groups also needs `editableBy(resolved, viewer)`:
 * on a public repo anyone can read the PR.
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

/**
 * Guided-review lookups give up sooner than `githubFetch`'s default: they
 * run before every guided-review request, and are small.
 */
export const REVIEW_LOOKUP_TIMEOUT_MS = 5000;

/** A failed lookup; pass it to `upstreamError` for the response. */
export type LookupFailure = FetchResult & { ok: false };

const fail = (status: number) => localFailure(status) as LookupFailure;

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
): Promise<{ ok: true; viewer: Viewer } | LookupFailure> {
  const key = createHash('sha256').update(token).digest('hex');
  const hit = viewerCache.get(key);
  if (hit && hit.expires > Date.now()) return { ok: true, viewer: hit.viewer };
  if (hit) viewerCache.delete(key);

  const result = await githubFetch('/user', token, REVIEW_LOOKUP_TIMEOUT_MS);
  if (!result.ok) return result as LookupFailure;
  const data = result.data as { id?: unknown; login?: unknown } | null;
  if (typeof data?.id !== 'number' || typeof data.login !== 'string') {
    return fail(502);
  }
  const viewer = { id: data.id, login: data.login };

  if (viewerCache.size >= VIEWER_CACHE_MAX) {
    const oldest = viewerCache.keys().next().value;
    if (oldest !== undefined) viewerCache.delete(oldest);
  }
  viewerCache.set(key, { viewer, expires: Date.now() + VIEWER_CACHE_TTL_MS });
  return { ok: true, viewer };
}

/** A PR read from GitHub, with what it says about the caller's access. */
export interface ResolvedPR {
  pr: VerifiedPR;
  /** GitHub user id of the PR's author. */
  authorId: number | null;
  /** The caller has push (or maintain/admin) access to the base repo. */
  canPush: boolean;
  /** GitHub's `changed_files` count, used to page the files list in parallel. */
  changedFiles: number | null;
  /** PR title and description, for AI clustering's context. */
  title: string;
  body: string | null;
}

interface GithubPRAccess {
  title?: unknown;
  body?: unknown;
  head?: { sha?: unknown };
  changed_files?: unknown;
  user?: { id?: unknown } | null;
  base?: {
    repo?: {
      permissions?: { push?: unknown; maintain?: unknown; admin?: unknown };
    };
  };
}

/**
 * Read the PR from GitHub with the caller's token and return it as the
 * `VerifiedPR` the data layer requires. A failure means the caller can't
 * read it (401/403/404 from GitHub), the input was invalid (400), or GitHub
 * failed (429/5xx, 504 on timeout).
 */
export async function resolvePR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<({ ok: true } & ResolvedPR) | LookupFailure> {
  if (!isGithubName(owner) || !isGithubName(repo)) return fail(400);
  if (!Number.isInteger(prNumber) || prNumber < 1) return fail(400);
  const result = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    token,
    REVIEW_LOOKUP_TIMEOUT_MS,
  );
  if (!result.ok) return result as LookupFailure;
  const data = result.data as GithubPRAccess | null;
  const headSha = data?.head?.sha;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return fail(502);
  }
  // `permissions` is only present for authenticated requests; absent → false.
  const perms = data?.base?.repo?.permissions;
  const authorId = data?.user?.id;
  return {
    ok: true,
    pr: verifiedPR({ owner, repo, prNumber, headSha }),
    authorId: typeof authorId === 'number' ? authorId : null,
    canPush:
      perms?.push === true || perms?.maintain === true || perms?.admin === true,
    changedFiles:
      typeof data?.changed_files === 'number' ? data.changed_files : null,
    title: typeof data?.title === 'string' ? data.title : '',
    body: typeof data?.body === 'string' ? data.body : null,
  };
}

/**
 * The PR as an `EditablePR` if this viewer may change its shared groups:
 * they wrote the PR or can push to the repo. Null otherwise (answer 403).
 */
export function editableBy(
  resolved: ResolvedPR,
  viewer: Viewer,
): EditablePR | null {
  const isAuthor =
    resolved.authorId !== null && resolved.authorId === viewer.id;
  return isAuthor || resolved.canPush ? editablePR(resolved.pr) : null;
}
