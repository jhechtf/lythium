import { and, asc, eq, inArray, max, ne } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';
import {
  reviewGroupFiles,
  reviewGroupReviews,
  reviewGroups,
  reviewViewedFiles,
} from './schema';

/**
 * Data access for guided-review state (LYT-60).
 *
 * - Groups are shared on a PR; reviewed and viewed marks belong to one GitHub
 *   user (numeric id from `GET /user`).
 * - All state is pinned to the PR head sha. Reads only return state for the
 *   sha they are given, and every write first discards state left over from
 *   older shas, so a push resets the review and groups are rebuilt.
 * - Every call is scoped to a PR, so a group id from another PR (or an older
 *   sha) is treated as not found.
 */

/** Any Drizzle Postgres database built on this schema (postgres-js, PGlite). */
export type ReviewDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PRKey {
  owner: string;
  repo: string;
  prNumber: number;
}

export type GroupSource = 'manual' | 'ai';

/** A file in a group. Lines refer to the new file; omit both for the whole file. */
export interface GroupFile {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
}

export interface ReviewGroup {
  id: number;
  name: string;
  description: string | null;
  position: number;
  source: GroupSource;
  createdBy: number | null;
  files: { path: string; startLine: number | null; endLine: number | null }[];
}

export interface NewGroup {
  name: string;
  description?: string | null;
  files: GroupFile[];
}

export interface ReviewProgress {
  headSha: string;
  groupsTotal: number;
  groupsReviewed: number;
  reviewedGroupIds: number[];
  /** Paths the user viewed at this sha. Files total comes from the diff. */
  viewedFiles: string[];
}

export class ReviewStateError extends Error {}

function normalizeFiles(files: GroupFile[]) {
  return files.map((f) => {
    const startLine = f.startLine ?? null;
    const endLine = f.endLine ?? null;
    if (!f.path) throw new ReviewStateError('File path is required');
    if ((startLine === null) !== (endLine === null)) {
      throw new ReviewStateError(
        `${f.path}: give both startLine and endLine, or neither`,
      );
    }
    if (
      startLine !== null &&
      endLine !== null &&
      (!Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine)
    ) {
      throw new ReviewStateError(`${f.path}: invalid line range`);
    }
    return { path: f.path, startLine, endLine };
  });
}

const prWhere = (pr: PRKey) =>
  and(
    eq(reviewGroups.owner, pr.owner),
    eq(reviewGroups.repo, pr.repo),
    eq(reviewGroups.prNumber, pr.prNumber),
  );

const groupWhere = (pr: PRKey, headSha: string, groupId: number) =>
  and(
    prWhere(pr),
    eq(reviewGroups.headSha, headSha),
    eq(reviewGroups.id, groupId),
  );

/**
 * Delete groups (with their files and reviewed marks) and viewed marks for
 * this PR that were made at any sha other than `headSha`.
 */
export async function discardStaleState(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
): Promise<void> {
  await db
    .delete(reviewGroups)
    .where(and(prWhere(pr), ne(reviewGroups.headSha, headSha)));
  await db
    .delete(reviewViewedFiles)
    .where(
      and(
        eq(reviewViewedFiles.owner, pr.owner),
        eq(reviewViewedFiles.repo, pr.repo),
        eq(reviewViewedFiles.prNumber, pr.prNumber),
        ne(reviewViewedFiles.headSha, headSha),
      ),
    );
}

/** Groups for the PR at `headSha`, in display order, with their files. */
export async function listGroups(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
): Promise<ReviewGroup[]> {
  const groups = await db
    .select()
    .from(reviewGroups)
    .where(and(prWhere(pr), eq(reviewGroups.headSha, headSha)))
    .orderBy(asc(reviewGroups.position), asc(reviewGroups.id));
  if (groups.length === 0) return [];

  const files = await db
    .select()
    .from(reviewGroupFiles)
    .where(
      inArray(
        reviewGroupFiles.groupId,
        groups.map((g) => g.id),
      ),
    )
    .orderBy(asc(reviewGroupFiles.id));

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    position: g.position,
    source: g.source as GroupSource,
    createdBy: g.createdBy,
    files: files
      .filter((f) => f.groupId === g.id)
      .map((f) => ({
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
      })),
  }));
}

export async function getGroup(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groupId: number,
): Promise<ReviewGroup | null> {
  const groups = await listGroups(db, pr, headSha);
  return groups.find((g) => g.id === groupId) ?? null;
}

async function insertGroup(
  tx: ReviewDb,
  pr: PRKey,
  headSha: string,
  group: NewGroup,
  position: number,
  source: GroupSource,
  createdBy: number | null,
) {
  const files = normalizeFiles(group.files);
  const [row] = await tx
    .insert(reviewGroups)
    .values({
      ...pr,
      headSha,
      name: group.name,
      description: group.description ?? null,
      position,
      source,
      createdBy,
    })
    .returning({ id: reviewGroups.id });
  if (files.length > 0) {
    await tx
      .insert(reviewGroupFiles)
      .values(files.map((f) => ({ ...f, groupId: row.id })));
  }
  return row.id;
}

/** Append a manually created group at the end of the list. */
export async function createGroup(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  group: NewGroup,
  createdBy: number,
): Promise<ReviewGroup> {
  const id = await db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    const [{ last }] = await tx
      .select({ last: max(reviewGroups.position) })
      .from(reviewGroups)
      .where(and(prWhere(pr), eq(reviewGroups.headSha, headSha)));
    return insertGroup(
      tx,
      pr,
      headSha,
      group,
      (last ?? -1) + 1,
      'manual',
      createdBy,
    );
  });
  // biome-ignore lint/style/noNonNullAssertion: inserted in the transaction above.
  return (await getGroup(db, pr, headSha, id))!;
}

/**
 * Replace every group on the PR (e.g. AI clustering regenerating them).
 * Reviewed marks on the old groups go with them.
 */
export async function replaceGroups(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groups: NewGroup[],
  source: GroupSource,
  createdBy: number | null,
): Promise<ReviewGroup[]> {
  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    await tx.delete(reviewGroups).where(prWhere(pr));
    for (const [i, g] of groups.entries()) {
      await insertGroup(tx, pr, headSha, g, i, source, createdBy);
    }
  });
  return listGroups(db, pr, headSha);
}

/** Update a group's name, description and/or files. Null if not found. */
export async function updateGroup(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groupId: number,
  patch: Partial<NewGroup>,
): Promise<ReviewGroup | null> {
  const found = await db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    const files = patch.files ? normalizeFiles(patch.files) : undefined;
    const updated = await tx
      .update(reviewGroups)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && {
          description: patch.description,
        }),
        updatedAt: new Date(),
      })
      .where(groupWhere(pr, headSha, groupId))
      .returning({ id: reviewGroups.id });
    if (updated.length === 0) return false;
    if (files) {
      await tx
        .delete(reviewGroupFiles)
        .where(eq(reviewGroupFiles.groupId, groupId));
      if (files.length > 0) {
        await tx
          .insert(reviewGroupFiles)
          .values(files.map((f) => ({ ...f, groupId })));
      }
    }
    return true;
  });
  return found ? getGroup(db, pr, headSha, groupId) : null;
}

/** Set display order. `groupIds` must list exactly the PR's current groups. */
export async function reorderGroups(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groupIds: number[],
): Promise<ReviewGroup[]> {
  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    const current = await tx
      .select({ id: reviewGroups.id })
      .from(reviewGroups)
      .where(and(prWhere(pr), eq(reviewGroups.headSha, headSha)));
    const have = new Set(current.map((g) => g.id));
    if (
      groupIds.length !== have.size ||
      new Set(groupIds).size !== groupIds.length ||
      !groupIds.every((id) => have.has(id))
    ) {
      throw new ReviewStateError('groupIds must list every group exactly once');
    }
    for (const [position, id] of groupIds.entries()) {
      await tx
        .update(reviewGroups)
        .set({ position, updatedAt: new Date() })
        .where(groupWhere(pr, headSha, id));
    }
  });
  return listGroups(db, pr, headSha);
}

/** Delete one group. False if it isn't on this PR at this sha. */
export async function deleteGroup(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groupId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(reviewGroups)
    .where(groupWhere(pr, headSha, groupId))
    .returning({ id: reviewGroups.id });
  return deleted.length > 0;
}

/** Mark or unmark a group reviewed for one user. False if no such group. */
export async function setGroupReviewed(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  groupId: number,
  userId: number,
  reviewed: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    const [group] = await tx
      .select({ id: reviewGroups.id })
      .from(reviewGroups)
      .where(groupWhere(pr, headSha, groupId));
    if (!group) return false;
    if (reviewed) {
      await tx
        .insert(reviewGroupReviews)
        .values({ groupId, userId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(reviewGroupReviews)
        .where(
          and(
            eq(reviewGroupReviews.groupId, groupId),
            eq(reviewGroupReviews.userId, userId),
          ),
        );
    }
    return true;
  });
}

/** Mark or unmark a file viewed for one user at `headSha`. */
export async function setFileViewed(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  userId: number,
  path: string,
  viewed: boolean,
): Promise<void> {
  if (!path) throw new ReviewStateError('File path is required');
  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr, headSha);
    if (viewed) {
      await tx
        .insert(reviewViewedFiles)
        .values({ ...pr, headSha, userId, path })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(reviewViewedFiles)
        .where(
          and(
            eq(reviewViewedFiles.owner, pr.owner),
            eq(reviewViewedFiles.repo, pr.repo),
            eq(reviewViewedFiles.prNumber, pr.prNumber),
            eq(reviewViewedFiles.headSha, headSha),
            eq(reviewViewedFiles.userId, userId),
            eq(reviewViewedFiles.path, path),
          ),
        );
    }
  });
}

/** One user's progress on the PR at `headSha`. */
export async function getProgress(
  db: ReviewDb,
  pr: PRKey,
  headSha: string,
  userId: number,
): Promise<ReviewProgress> {
  const groups = await db
    .select({ id: reviewGroups.id })
    .from(reviewGroups)
    .where(and(prWhere(pr), eq(reviewGroups.headSha, headSha)));
  const reviewed =
    groups.length === 0
      ? []
      : await db
          .select({ groupId: reviewGroupReviews.groupId })
          .from(reviewGroupReviews)
          .where(
            and(
              eq(reviewGroupReviews.userId, userId),
              inArray(
                reviewGroupReviews.groupId,
                groups.map((g) => g.id),
              ),
            ),
          );
  const viewed = await db
    .select({ path: reviewViewedFiles.path })
    .from(reviewViewedFiles)
    .where(
      and(
        eq(reviewViewedFiles.owner, pr.owner),
        eq(reviewViewedFiles.repo, pr.repo),
        eq(reviewViewedFiles.prNumber, pr.prNumber),
        eq(reviewViewedFiles.headSha, headSha),
        eq(reviewViewedFiles.userId, userId),
      ),
    )
    .orderBy(asc(reviewViewedFiles.path));

  const reviewedGroupIds = reviewed.map((r) => r.groupId).sort((a, b) => a - b);
  return {
    headSha,
    groupsTotal: groups.length,
    groupsReviewed: reviewedGroupIds.length,
    reviewedGroupIds,
    viewedFiles: viewed.map((v) => v.path),
  };
}
