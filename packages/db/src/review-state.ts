import { and, asc, eq, inArray, max, ne, sql } from 'drizzle-orm';
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
 *   PR's head sha, and every write first discards state left over from older
 *   shas, so a push resets the review and groups are rebuilt.
 * - Every call is scoped to a PR, so a group id from another PR (or an older
 *   sha) is treated as not found.
 *
 * Contract: every function takes a `VerifiedPR`. Because writes discard
 * every user's state for other shas, the head sha must come from GitHub,
 * never from the client: a made-up sha would wipe the PR's shared state, and
 * a stale tab would keep deleting newer state. Build one with `verifiedPR()`
 * only from `GET /repos/{owner}/{repo}/pulls/{n}` called with the caller's
 * token (the API's `resolvePR` does this). That same call proves the caller
 * can read the repo, which is the access check for both reads and writes.
 */

/** Any Drizzle Postgres database built on this schema (postgres-js, PGlite). */
export type ReviewDb = PgDatabase<PgQueryResultHKT, typeof schema>;

declare const verified: unique symbol;

/** A PR and its current head sha, as just read from GitHub. See the contract above. */
export type VerifiedPR = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
} & { readonly [verified]: true };

/**
 * Mark a PR as verified. Only pass values from GitHub's pulls API fetched
 * with the caller's token, never values from the request.
 */
export function verifiedPR(pr: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): VerifiedPR {
  return { ...pr } as VerifiedPR;
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

/** Invalid input. Routes should answer 400. */
export class ReviewStateError extends Error {}

/** Input caps, enforced on every write. Groups are shared, so keep them tight. */
export const REVIEW_LIMITS = {
  /** GitHub's diff limit is 3000 files. */
  filesPerGroup: 3000,
  /** Total file entries in one `replaceGroups` call. */
  filesPerReplace: 10_000,
  groupsPerPR: 200,
  pathLength: 4096,
  nameLength: 200,
  descriptionLength: 10_000,
} as const;

function checkPath(path: string) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ReviewStateError('File path is required');
  }
  if (path.length > REVIEW_LIMITS.pathLength) {
    throw new ReviewStateError(
      `File path is longer than ${REVIEW_LIMITS.pathLength} characters`,
    );
  }
}

function checkName(name: string) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ReviewStateError('Group name is required');
  }
  if (name.length > REVIEW_LIMITS.nameLength) {
    throw new ReviewStateError(
      `Group name is longer than ${REVIEW_LIMITS.nameLength} characters`,
    );
  }
}

function checkDescription(description: string | null | undefined) {
  if (
    description != null &&
    description.length > REVIEW_LIMITS.descriptionLength
  ) {
    throw new ReviewStateError(
      `Description is longer than ${REVIEW_LIMITS.descriptionLength} characters`,
    );
  }
}

function normalizeFiles(files: GroupFile[]) {
  if (!Array.isArray(files)) throw new ReviewStateError('files must be a list');
  if (files.length > REVIEW_LIMITS.filesPerGroup) {
    throw new ReviewStateError(
      `A group can have at most ${REVIEW_LIMITS.filesPerGroup} files`,
    );
  }
  return files.map((f) => {
    checkPath(f.path);
    const startLine = f.startLine ?? null;
    const endLine = f.endLine ?? null;
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

function normalizeGroup(group: NewGroup) {
  checkName(group.name);
  checkDescription(group.description);
  return {
    name: group.name,
    description: group.description ?? null,
    files: normalizeFiles(group.files),
  };
}

const prWhere = (pr: VerifiedPR) =>
  and(
    eq(reviewGroups.owner, pr.owner),
    eq(reviewGroups.repo, pr.repo),
    eq(reviewGroups.prNumber, pr.prNumber),
  );

const currentGroupsWhere = (pr: VerifiedPR) =>
  and(prWhere(pr), eq(reviewGroups.headSha, pr.headSha));

const groupWhere = (pr: VerifiedPR, groupId: number) =>
  and(currentGroupsWhere(pr), eq(reviewGroups.id, groupId));

type GroupRow = typeof reviewGroups.$inferSelect;
type FileRow = typeof reviewGroupFiles.$inferSelect;

function shapeGroups(groups: GroupRow[], files: FileRow[]): ReviewGroup[] {
  const byGroup = new Map<number, ReviewGroup['files']>();
  for (const f of files) {
    let list = byGroup.get(f.groupId);
    if (!list) {
      list = [];
      byGroup.set(f.groupId, list);
    }
    list.push({ path: f.path, startLine: f.startLine, endLine: f.endLine });
  }
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    position: g.position,
    source: g.source as GroupSource,
    createdBy: g.createdBy,
    files: byGroup.get(g.id) ?? [],
  }));
}

/**
 * Delete groups (with their files and reviewed marks) and viewed marks for
 * this PR that were made at any sha other than its current head.
 */
export async function discardStaleState(
  db: ReviewDb,
  pr: VerifiedPR,
): Promise<void> {
  await db
    .delete(reviewGroups)
    .where(and(prWhere(pr), ne(reviewGroups.headSha, pr.headSha)));
  await db
    .delete(reviewViewedFiles)
    .where(
      and(
        eq(reviewViewedFiles.owner, pr.owner),
        eq(reviewViewedFiles.repo, pr.repo),
        eq(reviewViewedFiles.prNumber, pr.prNumber),
        ne(reviewViewedFiles.headSha, pr.headSha),
      ),
    );
}

/** Groups for the PR at its head sha, in display order, with their files. */
export async function listGroups(
  db: ReviewDb,
  pr: VerifiedPR,
): Promise<ReviewGroup[]> {
  const groups = await db
    .select()
    .from(reviewGroups)
    .where(currentGroupsWhere(pr))
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
  return shapeGroups(groups, files);
}

/** One group with its files. Null if it isn't on this PR at its head sha. */
export async function getGroup(
  db: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
): Promise<ReviewGroup | null> {
  const [group] = await db
    .select()
    .from(reviewGroups)
    .where(groupWhere(pr, groupId));
  if (!group) return null;
  const files = await db
    .select()
    .from(reviewGroupFiles)
    .where(eq(reviewGroupFiles.groupId, groupId))
    .orderBy(asc(reviewGroupFiles.id));
  return shapeGroups([group], files)[0];
}

/** Append a manually created group at the end of the list. */
export async function createGroup(
  db: ReviewDb,
  pr: VerifiedPR,
  group: NewGroup,
  createdBy: number,
): Promise<ReviewGroup> {
  const g = normalizeGroup(group);
  const id = await db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    const [{ last, count }] = await tx
      .select({
        last: max(reviewGroups.position),
        count: sql<number>`count(*)::int`,
      })
      .from(reviewGroups)
      .where(currentGroupsWhere(pr));
    if (count >= REVIEW_LIMITS.groupsPerPR) {
      throw new ReviewStateError(
        `A PR can have at most ${REVIEW_LIMITS.groupsPerPR} groups`,
      );
    }
    const [row] = await tx
      .insert(reviewGroups)
      .values({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.prNumber,
        headSha: pr.headSha,
        name: g.name,
        description: g.description,
        position: (last ?? -1) + 1,
        source: 'manual',
        createdBy,
      })
      .returning({ id: reviewGroups.id });
    if (g.files.length > 0) {
      await tx
        .insert(reviewGroupFiles)
        .values(g.files.map((f) => ({ ...f, groupId: row.id })));
    }
    return row.id;
  });
  // biome-ignore lint/style/noNonNullAssertion: inserted in the transaction above.
  return (await getGroup(db, pr, id))!;
}

/**
 * Replace every group on the PR (e.g. AI clustering regenerating them).
 * Reviewed marks on the old groups go with them. Two inserts whatever the
 * group count: all groups, then all files.
 */
export async function replaceGroups(
  db: ReviewDb,
  pr: VerifiedPR,
  groups: NewGroup[],
  source: GroupSource,
  createdBy: number | null,
): Promise<ReviewGroup[]> {
  if (groups.length > REVIEW_LIMITS.groupsPerPR) {
    throw new ReviewStateError(
      `A PR can have at most ${REVIEW_LIMITS.groupsPerPR} groups`,
    );
  }
  const normalized = groups.map(normalizeGroup);
  const totalFiles = normalized.reduce((n, g) => n + g.files.length, 0);
  if (totalFiles > REVIEW_LIMITS.filesPerReplace) {
    throw new ReviewStateError(
      `At most ${REVIEW_LIMITS.filesPerReplace} file entries per replace`,
    );
  }

  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    await tx.delete(reviewGroups).where(prWhere(pr));
    if (normalized.length === 0) return;
    const inserted = await tx
      .insert(reviewGroups)
      .values(
        normalized.map((g, position) => ({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          name: g.name,
          description: g.description,
          position,
          source,
          createdBy,
        })),
      )
      .returning({ id: reviewGroups.id, position: reviewGroups.position });
    // Match ids by position rather than relying on RETURNING row order.
    const idAt = new Map(inserted.map((r) => [r.position, r.id]));
    const fileRows = normalized.flatMap((g, position) =>
      // biome-ignore lint/style/noNonNullAssertion: every position was inserted above.
      g.files.map((f) => ({ ...f, groupId: idAt.get(position)! })),
    );
    if (fileRows.length > 0) {
      await tx.insert(reviewGroupFiles).values(fileRows);
    }
  });
  return listGroups(db, pr);
}

/** Update a group's name, description and/or files. Null if not found. */
export async function updateGroup(
  db: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
  patch: Partial<NewGroup>,
): Promise<ReviewGroup | null> {
  if (patch.name !== undefined) checkName(patch.name);
  checkDescription(patch.description);
  const files = patch.files ? normalizeFiles(patch.files) : undefined;

  const found = await db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    const updated = await tx
      .update(reviewGroups)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && {
          description: patch.description,
        }),
        updatedAt: new Date(),
      })
      .where(groupWhere(pr, groupId))
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
  return found ? getGroup(db, pr, groupId) : null;
}

/** Set display order. `groupIds` must list exactly the PR's current groups. */
export async function reorderGroups(
  db: ReviewDb,
  pr: VerifiedPR,
  groupIds: number[],
): Promise<ReviewGroup[]> {
  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    const current = await tx
      .select({ id: reviewGroups.id })
      .from(reviewGroups)
      .where(currentGroupsWhere(pr));
    const have = new Set(current.map((g) => g.id));
    if (
      groupIds.length !== have.size ||
      new Set(groupIds).size !== groupIds.length ||
      !groupIds.every((id) => have.has(id))
    ) {
      throw new ReviewStateError('groupIds must list every group exactly once');
    }
    if (groupIds.length === 0) return;
    // One statement: each group's new position is its index in groupIds.
    const ids = sql.join(
      groupIds.map((id) => sql`${id}`),
      sql`, `,
    );
    await tx
      .update(reviewGroups)
      .set({
        position: sql`array_position(array[${ids}]::int[], ${reviewGroups.id}) - 1`,
        updatedAt: new Date(),
      })
      .where(currentGroupsWhere(pr));
  });
  return listGroups(db, pr);
}

/** Delete one group. False if it isn't on this PR at its head sha. */
export async function deleteGroup(
  db: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(reviewGroups)
    .where(groupWhere(pr, groupId))
    .returning({ id: reviewGroups.id });
  return deleted.length > 0;
}

/** Mark or unmark a group reviewed for one user. False if no such group. */
export async function setGroupReviewed(
  db: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
  userId: number,
  reviewed: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    const [group] = await tx
      .select({ id: reviewGroups.id })
      .from(reviewGroups)
      .where(groupWhere(pr, groupId));
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

/** Mark or unmark a file viewed for one user at the PR's head sha. */
export async function setFileViewed(
  db: ReviewDb,
  pr: VerifiedPR,
  userId: number,
  path: string,
  viewed: boolean,
): Promise<void> {
  checkPath(path);
  await db.transaction(async (tx) => {
    await discardStaleState(tx, pr);
    const key = {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
      headSha: pr.headSha,
      userId,
      path,
    };
    if (viewed) {
      await tx.insert(reviewViewedFiles).values(key).onConflictDoNothing();
    } else {
      await tx
        .delete(reviewViewedFiles)
        .where(
          and(
            eq(reviewViewedFiles.owner, key.owner),
            eq(reviewViewedFiles.repo, key.repo),
            eq(reviewViewedFiles.prNumber, key.prNumber),
            eq(reviewViewedFiles.headSha, key.headSha),
            eq(reviewViewedFiles.userId, key.userId),
            eq(reviewViewedFiles.path, key.path),
          ),
        );
    }
  });
}

/** One user's progress on the PR at its head sha. */
export async function getProgress(
  db: ReviewDb,
  pr: VerifiedPR,
  userId: number,
): Promise<ReviewProgress> {
  const groups = await db
    .select({ id: reviewGroups.id })
    .from(reviewGroups)
    .where(currentGroupsWhere(pr));
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
        eq(reviewViewedFiles.headSha, pr.headSha),
        eq(reviewViewedFiles.userId, userId),
      ),
    )
    .orderBy(asc(reviewViewedFiles.path));

  const reviewedGroupIds = reviewed.map((r) => r.groupId).sort((a, b) => a - b);
  return {
    headSha: pr.headSha,
    groupsTotal: groups.length,
    groupsReviewed: reviewedGroupIds.length,
    reviewedGroupIds,
    viewedFiles: viewed.map((v) => v.path),
  };
}
