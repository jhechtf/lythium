import { createDb, type ReviewDb } from '@lythium/db';
import { createMiddleware } from 'hono/factory';

/**
 * Wiring for guided-review state (LYT-60). The API runs without a database:
 * only routes that use `requireReviewDb` need `DATABASE_URL`, and they answer
 * 503 when it isn't set. The connection is opened on first use.
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

export interface Viewer {
  id: number;
  login: string;
}

/**
 * Identify the caller from their GitHub token via `GET /user`. Review state
 * is keyed by the numeric id (logins can be renamed); the token is never
 * stored.
 */
export async function fetchViewer(
  token: string,
): Promise<{ ok: true; viewer: Viewer } | { ok: false; status: number }> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lythium-api',
    },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as { id: number; login: string };
  return { ok: true, viewer: { id: data.id, login: data.login } };
}
