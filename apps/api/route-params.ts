import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
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

/**
 * Cheap checks for write routes, before the body is read: source, token and
 * params. A caller without a token can't make the API buffer a body. Handlers
 * repeat them later to get the values; they're pure and cost nothing.
 */
const checkRequest = createMiddleware(async (c, next) => {
  const badSource = unsupportedSource(c, c.req.param('source') ?? '');
  if (badSource) return badSource;
  const auth = bearerToken(c);
  if (auth.error) return auth.error;
  const params = repoParams(c);
  if (params.error) return params.error;
  await next();
});

/** Cap a write's body (→ 413) before it is buffered and parsed. */
const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

/**
 * Middleware a write route runs before its handler reads the body: the cheap
 * request checks, then a body cap of `mb` megabytes.
 */
export const beforeBodyChecks = (mb: number) =>
  [checkRequest, limitBody(mb * 1024 * 1024)] as const;

/**
 * The JSON body, or undefined when it isn't JSON (parsers then answer 400).
 * A body that streams past `bodyLimit` (no Content-Length) fails while being
 * read; that error is rethrown so `bodyLimit` answers 413.
 */
export const jsonBody = (c: Context) =>
  c.req.json().catch((err: unknown) => {
    if (err instanceof Error && err.name === 'BodyLimitError') throw err;
    return undefined;
  });
