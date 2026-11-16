import { and, asc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';
import {
  reviewGroupFiles,
  reviewGroupReviews,
  reviewGroups,
  reviewPrHeads,
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
 * can read the repo, which is the access check for reads and for the
 * caller's own reviewed/viewed marks.
 *
 * Groups are shared, and on a public repo anyone can read a PR, so changing
 * groups needs more: an `EditablePR`, which the API only grants to the PR's
 * author or a caller with push access (see `editablePR`).
 *
 * Writes take a per-PR advisory lock, so concurrent writes can't race past
 * the group cap or interleave a create with a reorder.
 *
 * The lock orders writes, but a `VerifiedPR` can be older than the write that
 * uses it: a request can read the PR from GitHub, wait, and take the lock
 * after a push and another request's writes. So each one carries `observedAt`
 * (when GitHub answered), and `review_pr_heads` keeps the newest head seen.
 * Under the lock, a write whose sha differs from a newer observation throws
 * `StaleHeadError` instead of deleting newer state; a newer observation moves
 * the head and discards the older sha's state.
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
  /** When GitHub reported `headSha`. Orders this observation against others. */
  readonly observedAt: Date;
} & { readonly [verified]: true };

/**
 * Mark a PR as verified. Only pass values from GitHub's pulls API fetched
 * with the caller's token, never values from the request. Call it as soon as
 * the response arrives: `observedAt` defaults to now.
 *
 * GitHub treats owner and repo names as case-insensitive, but the tables and
 * the write lock compare them as text. They are lowercased here so every
 * spelling of a PR's URL shares one set of groups, marks and one lock.
 */
export function verifiedPR(pr: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  observedAt?: Date;
}): VerifiedPR {
  return {
    ...pr,
    owner: pr.owner.toLowerCase(),
    repo: pr.repo.toLowerCase(),
    observedAt: pr.observedAt ?? new Date(),
  } as VerifiedPR;
}

declare const editable: unique symbol;

/** A `VerifiedPR` whose caller may change its shared groups. */
export type EditablePR = VerifiedPR & { readonly [editable]: true };

/**
 * Mark a verified PR as editable by the caller. Only call this once GitHub
 * (with the caller's token) shows the caller is the PR's author or has push
 * access to the repo, or for trusted server-side jobs (AI clustering).
 */
export function editablePR(pr: VerifiedPR): EditablePR {
  return pr as EditablePR;
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

/**
 * The PR's head moved after this request read it from GitHub, and newer state
 * exists. Routes should answer 409; the client can retry to get a fresh sha.
 */
export class StaleHeadError extends Error {}

/** Input caps, enforced on every write. Groups are shared, so keep them tight. */
export const REVIEW_LIMITS = {
  /** GitHub's diff limit is 3000 files. */
  filesPerGroup: 3000,
  /** Total file entries in one `replaceGroups` call. */
  filesPerReplace: 10_000,
  groupsPerPR: 200,
  /**
   * Viewed marks one user can hold on a PR at its head sha. Same as the diff
   * limit: a real reviewer can't view more files than the diff has.
   */
  viewedFilesPerUser: 3000,
  /**
   * UTF-8 bytes. `review_viewed_files` indexes the whole path in its primary
   * key, and Postgres rejects an index entry over about 2.7 kB, so a long,
   * incompressible path would make `setFileViewed` fail. 1 kB plus the other
   * key columns (owner and repo up to 100 each, 40-char sha) stays well under.
   */
  pathBytes: 1024,
  nameLength: 200,
  descriptionLength: 10_000,
} as const;

function checkPath(path: string) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ReviewStateError('File path is required');
  }
  // A character is at least one byte, so this rejects without encoding.
  if (
    path.length > REVIEW_LIMITS.pathBytes ||
    new TextEncoder().encode(path).length > REVIEW_LIMITS.pathBytes
  ) {
    throw new ReviewStateError(
      `File path is longer than ${REVIEW_LIMITS.pathBytes} bytes`,
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
 * Serialize writes to one PR until the transaction ends. Call first in every
 * write transaction: the group cap, positions and reorder all read, then
 * write. A hash collision between PRs only makes them wait for each other.
 */
async function lockPR(tx: ReviewDb, pr: VerifiedPR) {
  const key = `${pr.owner}/${pr.repo}#${pr.prNumber}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/**
 * Start a write transaction: lock the PR, check this request's head sha isn't
 * older than one already seen, then drop state from older shas.
 */
async function beginWrite(tx: ReviewDb, pr: VerifiedPR) {
  await lockPR(tx, pr);
  const [seen] = await tx
    .select()
    .from(reviewPrHeads)
    .where(
      and(
        eq(reviewPrHeads.owner, pr.owner),
        eq(reviewPrHeads.repo, pr.repo),
        eq(reviewPrHeads.prNumber, pr.prNumber),
      ),
    );
  const head = { headSha: pr.headSha, observedAt: pr.observedAt };

  if (seen && seen.headSha === pr.headSha) {
    // The common case: every tick of a file or group. State for other shas
    // was discarded when this sha was recorded, and any write at another sha
    // either was rejected or moved the head, so there is nothing to delete.
    // Still keep the newest observation time: a later request at a different
    // sha is judged against it (an older one must not displace this head).
    // `observed_at` is unindexed, so this is a cheap in-place update.
    if (seen.observedAt < pr.observedAt) {
      await tx
        .update(reviewPrHeads)
        .set({ observedAt: pr.observedAt })
        .where(
          and(
            eq(reviewPrHeads.owner, pr.owner),
            eq(reviewPrHeads.repo, pr.repo),
            eq(reviewPrHeads.prNumber, pr.prNumber),
          ),
        );
    }
    return;
  }

  // A tie goes to the later write: ms resolution can't order the two.
  if (seen && seen.observedAt > pr.observedAt) {
    throw new StaleHeadError(
      'The PR head changed since it was read; fetch it again',
    );
  }
  // First write for this PR, or a newer head: record it, drop older shas.
  await tx
    .insert(reviewPrHeads)
    .values({
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
      ...head,
    })
    .onConflictDoUpdate({
      target: [reviewPrHeads.owner, reviewPrHeads.repo, reviewPrHeads.prNumber],
      set: head,
    });
  await discardStaleState(tx, pr);
}

/**
 * Delete groups (with their files and reviewed marks) and viewed marks for
 * this PR that were made at any sha other than its current head. Only call
 * it from `beginWrite`, after the staleness check: on its own it would delete
 * newer state for an old observation.
 */
async function discardStaleState(db: ReviewDb, pr: VerifiedPR): Promise<void> {
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

/**
 * Run reads in one repeatable-read snapshot. A group and its files take two
 * queries, and a write can commit between them; at the default read-committed
 * level the reader would then return a group state that never existed.
 */
function snapshot<T>(db: ReviewDb, read: (q: ReviewDb) => Promise<T>) {
  return db.transaction(read, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

// The `read*` helpers take any query runner. Writes call them with their own
// transaction, which holds the PR lock, so their result is the state they
// just wrote. Readers go through `snapshot`.
async function readGroups(q: ReviewDb, pr: VerifiedPR): Promise<ReviewGroup[]> {
  const groups = await q
    .select()
    .from(reviewGroups)
    .where(currentGroupsWhere(pr))
    .orderBy(asc(reviewGroups.position), asc(reviewGroups.id));
  if (groups.length === 0) return [];
  const files = await q
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

async function readGroup(
  q: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
): Promise<ReviewGroup | null> {
  const [group] = await q
    .select()
    .from(reviewGroups)
    .where(groupWhere(pr, groupId));
  if (!group) return null;
  const files = await q
    .select()
    .from(reviewGroupFiles)
    .where(eq(reviewGroupFiles.groupId, groupId))
    .orderBy(asc(reviewGroupFiles.id));
  return shapeGroups([group], files)[0];
}

/** Groups for the PR at its head sha, in display order, with their files. */
export function listGroups(
  db: ReviewDb,
  pr: VerifiedPR,
): Promise<ReviewGroup[]> {
  return snapshot(db, (q) => readGroups(q, pr));
}

/** One group with its files. Null if it isn't on this PR at its head sha. */
export function getGroup(
  db: ReviewDb,
  pr: VerifiedPR,
  groupId: number,
): Promise<ReviewGroup | null> {
  return snapshot(db, (q) => readGroup(q, pr, groupId));
}

/** Append a manually created group at the end of the list. */
export async function createGroup(
  db: ReviewDb,
  pr: EditablePR,
  group: NewGroup,
  createdBy: number,
): Promise<ReviewGroup> {
  const g = normalizeGroup(group);
  return db.transaction(async (tx) => {
    await beginWrite(tx, pr);
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
    // Read it back while the PR lock still holds, so another write can't
    // delete it in between.
    const created = await readGroup(tx, pr, row.id);
    if (!created)
      throw new Error('Created group is missing in its transaction');
    return created;
  });
}

/**
 * Replace every group on the PR (e.g. AI clustering regenerating them).
 * Reviewed marks on the old groups go with them. Two inserts whatever the
 * group count: all groups, then all files.
 */
export async function replaceGroups(
  db: ReviewDb,
  pr: EditablePR,
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

  return db.transaction(async (tx) => {
    await beginWrite(tx, pr);
    await tx.delete(reviewGroups).where(prWhere(pr));
    if (normalized.length === 0) return [];
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
    return readGroups(tx, pr);
  });
}

/**
 * A change to one group. `files` replaces the whole file list; `addFiles` and
 * `removeFiles` edit it in place (and can't be combined with `files`), so two
 * people adding files to a shared group don't overwrite each other.
 */
export interface GroupPatch extends Partial<NewGroup> {
  /** Move the group to this index in the display order (past the end → last). */
  position?: number;
  /** Add these entries; one already in the group (same path and range) is skipped. */
  addFiles?: GroupFile[];
  /** Remove entries with exactly this path and range (no range = the whole-file entry). */
  removeFiles?: GroupFile[];
}

const fileKey = (f: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}) => `${f.startLine ?? ''}:${f.endLine ?? ''}:${f.path}`;

/** Write display order: each group's position is its index in `groupIds`. */
async function writeOrder(tx: ReviewDb, pr: VerifiedPR, groupIds: number[]) {
  if (groupIds.length === 0) return;
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
}

/** Update a group's name, description, position and/or files. Null if not found. */
export async function updateGroup(
  db: ReviewDb,
  pr: EditablePR,
  groupId: number,
  patch: GroupPatch,
): Promise<ReviewGroup | null> {
  if (patch.name !== undefined) checkName(patch.name);
  checkDescription(patch.description);
  const files = patch.files ? normalizeFiles(patch.files) : undefined;
  if (files && (patch.addFiles || patch.removeFiles)) {
    throw new ReviewStateError('Use files, or addFiles/removeFiles, not both');
  }
  const addFiles = patch.addFiles ? normalizeFiles(patch.addFiles) : [];
  const removeFiles = patch.removeFiles
    ? normalizeFiles(patch.removeFiles)
    : [];
  if (
    patch.position !== undefined &&
    (!Number.isInteger(patch.position) || patch.position < 0)
  ) {
    throw new ReviewStateError('position must be a non-negative integer');
  }

  return db.transaction(async (tx) => {
    await beginWrite(tx, pr);
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
    if (updated.length === 0) return null;

    if (files) {
      await tx
        .delete(reviewGroupFiles)
        .where(eq(reviewGroupFiles.groupId, groupId));
      if (files.length > 0) {
        await tx
          .insert(reviewGroupFiles)
          .values(files.map((f) => ({ ...f, groupId })));
      }
    } else if (addFiles.length > 0 || removeFiles.length > 0) {
      const current = await tx
        .select()
        .from(reviewGroupFiles)
        .where(eq(reviewGroupFiles.groupId, groupId));
      const remove = new Set(removeFiles.map(fileKey));
      const dropIds = current
        .filter((f) => remove.has(fileKey(f)))
        .map((f) => f.id);
      const kept = new Set(
        current.filter((f) => !remove.has(fileKey(f))).map(fileKey),
      );
      const insert: typeof addFiles = [];
      for (const f of addFiles) {
        const key = fileKey(f);
        if (kept.has(key)) continue;
        kept.add(key);
        insert.push(f);
      }
      if (kept.size > REVIEW_LIMITS.filesPerGroup) {
        throw new ReviewStateError(
          `A group can have at most ${REVIEW_LIMITS.filesPerGroup} files`,
        );
      }
      if (dropIds.length > 0) {
        await tx
          .delete(reviewGroupFiles)
          .where(inArray(reviewGroupFiles.id, dropIds));
      }
      if (insert.length > 0) {
        await tx
          .insert(reviewGroupFiles)
          .values(insert.map((f) => ({ ...f, groupId })));
      }
    }

    if (patch.position !== undefined) {
      const order = (
        await tx
          .select({ id: reviewGroups.id })
          .from(reviewGroups)
          .where(currentGroupsWhere(pr))
          .orderBy(asc(reviewGroups.position), asc(reviewGroups.id))
      )
        .map((g) => g.id)
        .filter((id) => id !== groupId);
      order.splice(Math.min(patch.position, order.length), 0, groupId);
      await writeOrder(tx, pr, order);
    }
    return readGroup(tx, pr, groupId);
  });
}

/** Set display order. `groupIds` must list exactly the PR's current groups. */
export async function reorderGroups(
  db: ReviewDb,
  pr: EditablePR,
  groupIds: number[],
): Promise<ReviewGroup[]> {
  return db.transaction(async (tx) => {
    await beginWrite(tx, pr);
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
    if (groupIds.length === 0) return [];
    // One statement: each group's new position is its index in groupIds.
    await writeOrder(tx, pr, groupIds);
    return readGroups(tx, pr);
  });
}

/** Delete one group. False if it isn't on this PR at its head sha. */
export async function deleteGroup(
  db: ReviewDb,
  pr: EditablePR,
  groupId: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await beginWrite(tx, pr);
    const deleted = await tx
      .delete(reviewGroups)
      .where(groupWhere(pr, groupId))
      .returning({ id: reviewGroups.id });
    return deleted.length > 0;
  });
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
    await beginWrite(tx, pr);
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
export function setFileViewed(
  db: ReviewDb,
  pr: VerifiedPR,
  userId: number,
  path: string,
  viewed: boolean,
): Promise<void> {
  return setFilesViewed(db, pr, userId, [path], viewed);
}

/**
 * Mark or unmark several files viewed for one user at the PR's head sha, in
 * one transaction (e.g. "mark folder as viewed"). Marking an already viewed
 * file, or unmarking one that isn't, is a no-op.
 */
export async function setFilesViewed(
  db: ReviewDb,
  pr: VerifiedPR,
  userId: number,
  paths: string[],
  viewed: boolean,
): Promise<void> {
  if (!Array.isArray(paths)) throw new ReviewStateError('paths must be a list');
  if (paths.length > REVIEW_LIMITS.viewedFilesPerUser) {
    throw new ReviewStateError(
      `At most ${REVIEW_LIMITS.viewedFilesPerUser} files per call`,
    );
  }
  for (const path of paths) checkPath(path);
  const unique = [...new Set(paths)];

  await db.transaction(async (tx) => {
    // Even an empty batch records the head it observed, so an older
    // observation that arrives later is rejected instead of winning.
    await beginWrite(tx, pr);
    if (unique.length === 0) return;
    const userAtHead = and(
      eq(reviewViewedFiles.owner, pr.owner),
      eq(reviewViewedFiles.repo, pr.repo),
      eq(reviewViewedFiles.prNumber, pr.prNumber),
      eq(reviewViewedFiles.headSha, pr.headSha),
      eq(reviewViewedFiles.userId, userId),
    );
    if (!viewed) {
      await tx
        .delete(reviewViewedFiles)
        .where(and(userAtHead, inArray(reviewViewedFiles.path, unique)));
      return;
    }
    const inserted = await tx
      .insert(reviewViewedFiles)
      .values(
        unique.map((path) => ({
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          userId,
          path,
        })),
      )
      .onConflictDoNothing()
      .returning({ path: reviewViewedFiles.path });
    // Only new marks can push the user over the cap; re-marking files that
    // are already viewed stays fine at the limit. The PR is locked, so this
    // count can't race another write. Throwing rolls the inserts back.
    if (inserted.length > 0) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewViewedFiles)
        .where(userAtHead);
      if (count > REVIEW_LIMITS.viewedFilesPerUser) {
        throw new ReviewStateError(
          `At most ${REVIEW_LIMITS.viewedFilesPerUser} files can be marked viewed per PR`,
        );
      }
    }
  });
}

/** One user's progress on the PR at its head sha. */
export function getProgress(
  db: ReviewDb,
  pr: VerifiedPR,
  userId: number,
): Promise<ReviewProgress> {
  // Three queries, so one snapshot: otherwise a regenerate or a push that
  // commits between them mixes counts from different group sets.
  return snapshot(db, async (q) => {
    const groups = await q
      .select({ id: reviewGroups.id })
      .from(reviewGroups)
      .where(currentGroupsWhere(pr));
    const reviewed =
      groups.length === 0
        ? []
        : await q
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
    const viewed = await q
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

    const reviewedGroupIds = reviewed
      .map((r) => r.groupId)
      .sort((a, b) => a - b);
    return {
      headSha: pr.headSha,
      groupsTotal: groups.length,
      groupsReviewed: reviewedGroupIds.length,
      reviewedGroupIds,
      viewedFiles: viewed.map((v) => v.path),
    };
  });
}
