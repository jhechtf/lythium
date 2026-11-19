import {
  getProgress,
  ReviewStateError,
  setFilesViewed,
  setGroupReviewed,
} from '@lythium/db';
import { Hono } from 'hono';
import { requireReviewDb } from './review-context.ts';
import {
  beforeBody,
  groupId,
  groupNotFound,
  guidedRequest,
  isObject,
  type ReviewEnv,
  stateError,
} from './review-groups.ts';
import { jsonBody } from './route-params.ts';
import type { ReviewProgressResponse } from './types.ts';

/**
 * Review progress routes (LYT-62), mounted next to the group routes. Marks
 * are private to the caller and need only read access to the PR (the
 * `resolvePR` lookup), unlike group changes. They're pinned to the head sha,
 * so a push resets them: a file that changed since it was viewed has to be
 * viewed again.
 */

function parseReviewed(v: unknown): boolean {
  if (!isObject(v) || typeof v.reviewed !== 'boolean') {
    throw new ReviewStateError('reviewed must be true or false');
  }
  return v.reviewed;
}

function parseViewed(v: unknown): { paths: string[]; viewed: boolean } {
  if (!isObject(v) || typeof v.viewed !== 'boolean') {
    throw new ReviewStateError('viewed must be true or false');
  }
  if (
    !Array.isArray(v.paths) ||
    !v.paths.every((p): p is string => typeof p === 'string')
  ) {
    throw new ReviewStateError('paths must be a list of file paths');
  }
  return { paths: v.paths, viewed: v.viewed };
}

export const reviewProgressRoutes = new Hono<ReviewEnv>()
  .put('/groups/:group_id/reviewed', ...beforeBody(1), async (c) => {
    const id = groupId(c);
    if (id === null) return groupNotFound(c, c.req.param('group_id'));
    try {
      const reviewed = parseReviewed(await jsonBody(c));
      const req = await guidedRequest(c, { files: false });
      if ('error' in req) return req.error;
      const found = await setGroupReviewed(
        req.db,
        req.resolved.pr,
        id,
        req.viewer.id,
        reviewed,
      );
      if (!found) return groupNotFound(c, id);
      return c.body(null, 204);
    } catch (err) {
      return stateError(c, err);
    }
  })
  .put('/files/viewed', ...beforeBody(4), async (c) => {
    try {
      const { paths, viewed } = parseViewed(await jsonBody(c));
      // No PR file lookup: ticking a file is the hottest write, and a path
      // that isn't in the PR is harmless (progress only counts PR files) and
      // capped per user by the data layer.
      const req = await guidedRequest(c, { files: false });
      if ('error' in req) return req.error;
      await setFilesViewed(
        req.db,
        req.resolved.pr,
        req.viewer.id,
        paths,
        viewed,
      );
      return c.body(null, 204);
    } catch (err) {
      return stateError(c, err);
    }
  })
  .get('/progress', requireReviewDb, async (c) => {
    const req = await guidedRequest(c, { files: true });
    if ('error' in req) return req.error;
    try {
      const p = await getProgress(req.db, req.resolved.pr, req.viewer.id);
      const inPR = new Set(req.prFiles.map((f) => f.path));
      const viewedPaths = p.viewedFiles.filter((path) => inPR.has(path));
      return c.json<ReviewProgressResponse>({
        headSha: p.headSha,
        groups: {
          total: p.groupsTotal,
          reviewed: p.groupsReviewed,
          reviewedIds: p.reviewedGroupIds,
        },
        files: {
          total: req.prFiles.length,
          viewed: viewedPaths.length,
          viewedPaths,
        },
      });
    } catch (err) {
      return stateError(c, err);
    }
  });
