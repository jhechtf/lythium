import {
  createGroup,
  deleteGroup,
  type EditablePR,
  type GroupPatch,
  listGroups,
  type NewGroup,
  type ReviewDb,
  ReviewStateError,
  replaceGroups,
  StaleHeadError,
  updateGroup,
} from '@lythium/db';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { upstreamError } from './github.ts';
import {
  checkFilesInPR,
  fetchPRFiles,
  type GroupFileInput,
  type PRFile,
  unassignedFiles,
} from './pr-files.ts';
import {
  editableBy,
  fetchViewer,
  type ResolvedPR,
  requireReviewDb,
  resolvePR,
  type Viewer,
} from './review-context.ts';
import { bearerToken, repoParams, unsupportedSource } from './route-params.ts';
import type {
  ReviewGroup,
  ReviewGroupSource,
  ReviewGroupsResponse,
} from './types.ts';

/**
 * Guided-review routes, mounted at `/repos/:source/:owner/:repo/pr/:pr_number`.
 * Groups (LYT-61): list, create, update, delete, replace. Everything goes
 * through `guidedRequest`, which does the GitHub lookups (PR, viewer and,
 * when needed, the PR's files) in parallel.
 */

export type ReviewEnv = { Variables: { reviewDb: ReviewDb } };

export interface GuidedRequest {
  db: ReviewDb;
  resolved: ResolvedPR;
  viewer: Viewer;
  /** Empty unless the route asked for files. */
  prFiles: PRFile[];
  prNumber: string;
}

/**
 * Common preamble for guided-review routes: source, token, params, then the
 * GitHub lookups in parallel. Returns a ready response on any failure.
 */
export async function guidedRequest(
  c: Context<ReviewEnv>,
  opts: { files: boolean },
): Promise<GuidedRequest | { error: Response }> {
  const badSource = unsupportedSource(c, c.req.param('source') ?? '');
  if (badSource) return { error: badSource };
  const auth = bearerToken(c);
  if (auth.error) return { error: auth.error };
  const params = repoParams(c);
  if (params.error) return { error: params.error };
  const { owner, repo, pr_number } = params;
  const n = Number(pr_number);

  const resolving = resolvePR(auth.token, owner, repo, n);
  const [resolved, viewer, files] = await Promise.all([
    resolving,
    fetchViewer(auth.token),
    opts.files
      ? fetchPRFiles(
          auth.token,
          owner,
          repo,
          n,
          resolving.then((r) => (r.ok ? r.changedFiles : null)),
        )
      : null,
  ]);
  if (!resolved.ok) return { error: upstreamError(c, resolved, pr_number) };
  if (!viewer.ok) return { error: upstreamError(c, viewer, pr_number) };
  if (files && !files.ok) return { error: upstreamError(c, files, pr_number) };
  return {
    db: c.get('reviewDb'),
    resolved,
    viewer: viewer.viewer,
    prFiles: files?.files ?? [],
    prNumber: pr_number,
  };
}

/** Data-layer errors → responses: bad input 400, stale head 409. */
export function stateError(c: Context, err: unknown): Response {
  if (err instanceof ReviewStateError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof StaleHeadError) {
    return c.json({ error: err.message }, 409);
  }
  throw err;
}

/** The PR as editable by this caller, or a 403 response. */
function requireEditable(
  c: Context,
  req: GuidedRequest,
): EditablePR | Response {
  return (
    editableBy(req.resolved, req.viewer) ??
    c.json(
      {
        error:
          'Only the PR author or someone with push access can change review groups',
      },
      403,
    )
  );
}

// ---------------------------------------------------------------------------
// Request bodies. Shape errors throw ReviewStateError, so they answer 400
// through `stateError` like the data layer's own checks.
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const optionalLine = (v: unknown, field: string) => {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'number') {
    throw new ReviewStateError(`${field} must be a number`);
  }
  return v;
};

function parseFiles(v: unknown, field: string): GroupFileInput[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ReviewStateError(`${field} must be a list`);
  return v.map((f) => {
    if (!isObject(f) || typeof f.path !== 'string') {
      throw new ReviewStateError(`${field}: each entry needs a path`);
    }
    return {
      path: f.path,
      startLine: optionalLine(f.startLine, 'startLine'),
      endLine: optionalLine(f.endLine, 'endLine'),
    };
  });
}

function parseDescription(v: unknown) {
  if (v === undefined || v === null || typeof v === 'string') return v;
  throw new ReviewStateError('description must be a string');
}

function parseNewGroup(v: unknown): NewGroup {
  if (!isObject(v)) throw new ReviewStateError('Expected a JSON object');
  if (typeof v.name !== 'string') {
    throw new ReviewStateError('name is required');
  }
  return {
    name: v.name,
    description: parseDescription(v.description),
    files: parseFiles(v.files, 'files') ?? [],
  };
}

function parsePatch(v: unknown): GroupPatch {
  if (!isObject(v)) throw new ReviewStateError('Expected a JSON object');
  if (v.name !== undefined && typeof v.name !== 'string') {
    throw new ReviewStateError('name must be a string');
  }
  if (v.position !== undefined && typeof v.position !== 'number') {
    throw new ReviewStateError('position must be a number');
  }
  return {
    ...(v.name !== undefined && { name: v.name as string }),
    ...(v.description !== undefined && {
      description: parseDescription(v.description),
    }),
    ...(v.position !== undefined && { position: v.position as number }),
    ...(v.files !== undefined && { files: parseFiles(v.files, 'files') }),
    ...(v.addFiles !== undefined && {
      addFiles: parseFiles(v.addFiles, 'addFiles'),
    }),
    ...(v.removeFiles !== undefined && {
      removeFiles: parseFiles(v.removeFiles, 'removeFiles'),
    }),
  };
}

function parseReplace(v: unknown): {
  groups: NewGroup[];
  source: ReviewGroupSource;
} {
  if (!isObject(v) || !Array.isArray(v.groups)) {
    throw new ReviewStateError('groups must be a list');
  }
  const source = v.source ?? 'manual';
  if (source !== 'manual' && source !== 'ai') {
    throw new ReviewStateError("source must be 'manual' or 'ai'");
  }
  return { groups: v.groups.map(parseNewGroup), source };
}

/**
 * Cheap checks for write routes, before the body is read: source, token and
 * params. A caller without a token can't make the API buffer a body.
 * `guidedRequest` repeats them later; they're pure and cost nothing.
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

/**
 * Cap a write's body before it is buffered and parsed, sized to what the
 * input caps allow: up to 1 kB per path, plus names and descriptions.
 * `PUT` (10k entries) and `PATCH` (files + addFiles + removeFiles, 3000 each)
 * need ~10 MB; `POST` (one group, 3000 files) needs ~3 MB.
 */
const limitBody = (mb: number) =>
  bodyLimit({
    maxSize: mb * 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

/** Middleware every write route runs before its handler reads the body. */
const beforeBody = (mb: number) =>
  [requireReviewDb, checkRequest, limitBody(mb)] as const;

/**
 * The JSON body, or undefined when it isn't JSON (parsers then answer 400).
 * A body that streams past `bodyLimit` (no Content-Length) fails while being
 * read; that error is rethrown so `bodyLimit` answers 413.
 */
const jsonBody = (c: Context) =>
  c.req.json().catch((err: unknown) => {
    if (err instanceof Error && err.name === 'BodyLimitError') throw err;
    return undefined;
  });

function groupId(c: Context): number | null {
  const id = c.req.param('group_id') ?? '';
  return /^[1-9]\d{0,9}$/.test(id) ? Number(id) : null;
}

const groupNotFound = (c: Context, id: string | number) =>
  c.json({ error: `Group ${id} not found` }, 404);

/** A group entry referenced a file the PR doesn't change: 400. */
function filesNotInPR(
  c: Context,
  entries: GroupFileInput[],
  req: GuidedRequest,
) {
  const problem = checkFilesInPR(entries, req.prFiles);
  return problem ? c.json({ error: problem }, 400) : null;
}

const groupsResponse = (
  req: GuidedRequest,
  groups: ReviewGroup[],
): ReviewGroupsResponse => ({
  headSha: req.resolved.pr.headSha,
  groups,
  unassigned: unassignedFiles(req.prFiles, groups),
  totalFiles: req.prFiles.length,
});

export const reviewGroupRoutes = new Hono<ReviewEnv>()
  .get('/groups', requireReviewDb, async (c) => {
    const req = await guidedRequest(c, { files: true });
    if ('error' in req) return req.error;
    try {
      const groups = await listGroups(req.db, req.resolved.pr);
      return c.json<ReviewGroupsResponse>(groupsResponse(req, groups));
    } catch (err) {
      return stateError(c, err);
    }
  })
  .post('/groups', ...beforeBody(4), async (c) => {
    try {
      const group = parseNewGroup(await jsonBody(c));
      const req = await guidedRequest(c, { files: group.files.length > 0 });
      if ('error' in req) return req.error;
      const pr = requireEditable(c, req);
      if (pr instanceof Response) return pr;
      const bad = filesNotInPR(c, group.files, req);
      if (bad) return bad;
      const created = await createGroup(req.db, pr, group, req.viewer.id);
      return c.json<ReviewGroup>(created, 201);
    } catch (err) {
      return stateError(c, err);
    }
  })
  .put('/groups', ...beforeBody(12), async (c) => {
    try {
      const { groups, source } = parseReplace(await jsonBody(c));
      const req = await guidedRequest(c, { files: true });
      if ('error' in req) return req.error;
      const pr = requireEditable(c, req);
      if (pr instanceof Response) return pr;
      const bad = filesNotInPR(
        c,
        groups.flatMap((g) => g.files),
        req,
      );
      if (bad) return bad;
      const saved = await replaceGroups(
        req.db,
        pr,
        groups,
        source,
        // AI groups have no human author, even when a person accepts them.
        source === 'ai' ? null : req.viewer.id,
      );
      return c.json<ReviewGroupsResponse>(groupsResponse(req, saved));
    } catch (err) {
      return stateError(c, err);
    }
  })
  .patch('/groups/:group_id', ...beforeBody(12), async (c) => {
    const id = groupId(c);
    if (id === null) return groupNotFound(c, c.req.param('group_id'));
    try {
      const patch = parsePatch(await jsonBody(c));
      const added = [...(patch.files ?? []), ...(patch.addFiles ?? [])];
      const req = await guidedRequest(c, { files: added.length > 0 });
      if ('error' in req) return req.error;
      const pr = requireEditable(c, req);
      if (pr instanceof Response) return pr;
      // Removing needn't match the PR: it may clean up a stale entry.
      const bad = filesNotInPR(c, added, req);
      if (bad) return bad;
      const updated = await updateGroup(req.db, pr, id, patch);
      if (!updated) return groupNotFound(c, id);
      return c.json<ReviewGroup>(updated);
    } catch (err) {
      return stateError(c, err);
    }
  })
  .delete('/groups/:group_id', requireReviewDb, async (c) => {
    const id = groupId(c);
    if (id === null) return groupNotFound(c, c.req.param('group_id'));
    const req = await guidedRequest(c, { files: false });
    if ('error' in req) return req.error;
    const pr = requireEditable(c, req);
    if (pr instanceof Response) return pr;
    try {
      if (!(await deleteGroup(req.db, pr, id))) return groupNotFound(c, id);
      return c.body(null, 204);
    } catch (err) {
      return stateError(c, err);
    }
  });
