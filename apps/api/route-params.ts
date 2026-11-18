import type { Context } from 'hono';
import { isGithubName } from './github.ts';

/**
 * Validate the route's repo and PR params and build the GitHub path prefix.
 * Hono URL-decodes params, so an unchecked `..%2F` would let a request reach
 * any GitHub endpoint with the caller's token. `encodeURIComponent` alone
 * doesn't stop `..` (fetch resolves dot segments), hence the name check.
 */
export function repoParams(c: Context) {
  const { owner, repo, pr_number } = c.req.param() as Record<string, string>;
  if (!isGithubName(owner) || !isGithubName(repo)) {
    return { error: c.json({ error: 'Invalid owner or repo' }, 400) } as const;
  }
  if (!/^[1-9]\d{0,9}$/.test(pr_number)) {
    return { error: c.json({ error: 'Invalid PR number' }, 400) } as const;
  }
  return {
    owner,
    repo,
    pr_number,
    base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  } as const;
}

// Hosting platforms we can talk to. `:source` in the URL selects one; only
// GitHub has an implementation today (GitLab / Forgejo are planned).
export const SUPPORTED_SOURCES = ['github'] as const;

export function unsupportedSource(c: Context, source: string) {
  if ((SUPPORTED_SOURCES as readonly string[]).includes(source)) return null;
  return c.json(
    {
      error: `Unsupported source '${source}'`,
      supported: SUPPORTED_SOURCES,
    },
    400,
  );
}

/** The caller's token from `Authorization: Bearer <token>`, or a 401. */
export function bearerToken(c: Context) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: c.json({ error: 'Missing or invalid Authorization header' }, 401),
    } as const;
  }
  return { token: authHeader.slice(7) } as const;
}
