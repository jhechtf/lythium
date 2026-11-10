import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGroup,
  deleteGroup,
  getProgress,
  listGroups,
  type PRKey,
  ReviewStateError,
  reorderGroups,
  replaceGroups,
  setFileViewed,
  setGroupReviewed,
  updateGroup,
} from './review-state';
import * as schema from './schema';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

// One in-process Postgres with the real migrations applied, emptied per test.
async function migratedDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

const PR: PRKey = { owner: 'o', repo: 'r', prNumber: 7 };
const OTHER_PR: PRKey = { owner: 'o', repo: 'r', prNumber: 8 };
const SHA = 'sha-1';
const NEW_SHA = 'sha-2';
const ALICE = 101;
const BOB = 202;

describe('review state', () => {
  let db: Awaited<ReturnType<typeof migratedDb>>;
  beforeAll(async () => {
    db = await migratedDb();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate review_groups, review_group_files, review_group_reviews, review_viewed_files restart identity cascade`,
    );
  });

  describe('groups', () => {
    it('creates groups in order with whole-file and line-range members', async () => {
      const a = await createGroup(
        db,
        PR,
        SHA,
        {
          name: 'API',
          description: 'endpoint changes',
          files: [
            { path: 'app.ts' },
            { path: 'types.ts', startLine: 10, endLine: 20 },
          ],
        },
        ALICE,
      );
      const b = await createGroup(
        db,
        PR,
        SHA,
        { name: 'Tests', files: [] },
        BOB,
      );

      expect(a).toMatchObject({
        name: 'API',
        description: 'endpoint changes',
        position: 0,
        source: 'manual',
        createdBy: ALICE,
        files: [
          { path: 'app.ts', startLine: null, endLine: null },
          { path: 'types.ts', startLine: 10, endLine: 20 },
        ],
      });
      expect(b.position).toBe(1);
      expect((await listGroups(db, PR, SHA)).map((g) => g.name)).toEqual([
        'API',
        'Tests',
      ]);
    });

    it('rejects half-open and inverted line ranges', async () => {
      await expect(
        createGroup(
          db,
          PR,
          SHA,
          { name: 'x', files: [{ path: 'a.ts', startLine: 3 }] },
          ALICE,
        ),
      ).rejects.toBeInstanceOf(ReviewStateError);
      await expect(
        createGroup(
          db,
          PR,
          SHA,
          { name: 'x', files: [{ path: 'a.ts', startLine: 9, endLine: 2 }] },
          ALICE,
        ),
      ).rejects.toBeInstanceOf(ReviewStateError);
      expect(await listGroups(db, PR, SHA)).toEqual([]);
    });

    it('updates name and replaces files', async () => {
      const g = await createGroup(
        db,
        PR,
        SHA,
        { name: 'old', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      const updated = await updateGroup(db, PR, SHA, g.id, {
        name: 'new',
        files: [{ path: 'b.ts', startLine: 1, endLine: 5 }],
      });
      expect(updated).toMatchObject({
        name: 'new',
        files: [{ path: 'b.ts', startLine: 1, endLine: 5 }],
      });
    });

    it('reorders groups and rejects an incomplete order', async () => {
      const a = await createGroup(db, PR, SHA, { name: 'a', files: [] }, ALICE);
      const b = await createGroup(db, PR, SHA, { name: 'b', files: [] }, ALICE);
      const out = await reorderGroups(db, PR, SHA, [b.id, a.id]);
      expect(out.map((g) => g.name)).toEqual(['b', 'a']);
      await expect(reorderGroups(db, PR, SHA, [a.id])).rejects.toBeInstanceOf(
        ReviewStateError,
      );
    });

    it('deletes a group with its files and reviewed marks', async () => {
      const g = await createGroup(
        db,
        PR,
        SHA,
        { name: 'a', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      await setGroupReviewed(db, PR, SHA, g.id, ALICE, true);
      expect(await deleteGroup(db, PR, SHA, g.id)).toBe(true);
      expect(await listGroups(db, PR, SHA)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupFiles)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupReviews)).toEqual([]);
    });

    it('replaces all groups, e.g. on AI regeneration', async () => {
      await createGroup(db, PR, SHA, { name: 'manual', files: [] }, ALICE);
      const out = await replaceGroups(
        db,
        PR,
        SHA,
        [
          { name: 'one', files: [{ path: 'a.ts' }] },
          { name: 'two', files: [] },
        ],
        'ai',
        null,
      );
      expect(out.map((g) => [g.name, g.position, g.source])).toEqual([
        ['one', 0, 'ai'],
        ['two', 1, 'ai'],
      ]);
    });

    it('treats a group from another PR as not found', async () => {
      const g = await createGroup(db, PR, SHA, { name: 'a', files: [] }, ALICE);
      expect(await updateGroup(db, OTHER_PR, SHA, g.id, { name: 'x' })).toBe(
        null,
      );
      expect(await deleteGroup(db, OTHER_PR, SHA, g.id)).toBe(false);
      expect(await setGroupReviewed(db, OTHER_PR, SHA, g.id, ALICE, true)).toBe(
        false,
      );
      expect((await listGroups(db, PR, SHA))[0].name).toBe('a');
    });
  });

  describe('progress', () => {
    it('keeps reviewed and viewed marks private to each user', async () => {
      const a = await createGroup(db, PR, SHA, { name: 'a', files: [] }, ALICE);
      await createGroup(db, PR, SHA, { name: 'b', files: [] }, ALICE);
      await setGroupReviewed(db, PR, SHA, a.id, ALICE, true);
      await setFileViewed(db, PR, SHA, ALICE, 'a.ts', true);
      await setFileViewed(db, PR, SHA, ALICE, 'b.ts', true);

      expect(await getProgress(db, PR, SHA, ALICE)).toEqual({
        headSha: SHA,
        groupsTotal: 2,
        groupsReviewed: 1,
        reviewedGroupIds: [a.id],
        viewedFiles: ['a.ts', 'b.ts'],
      });
      expect(await getProgress(db, PR, SHA, BOB)).toMatchObject({
        groupsTotal: 2,
        groupsReviewed: 0,
        viewedFiles: [],
      });
    });

    it('marking twice is idempotent, and marks can be removed', async () => {
      const a = await createGroup(db, PR, SHA, { name: 'a', files: [] }, ALICE);
      await setGroupReviewed(db, PR, SHA, a.id, ALICE, true);
      await setGroupReviewed(db, PR, SHA, a.id, ALICE, true);
      await setFileViewed(db, PR, SHA, ALICE, 'a.ts', true);
      await setFileViewed(db, PR, SHA, ALICE, 'a.ts', true);
      expect(await getProgress(db, PR, SHA, ALICE)).toMatchObject({
        groupsReviewed: 1,
        viewedFiles: ['a.ts'],
      });

      await setGroupReviewed(db, PR, SHA, a.id, ALICE, false);
      await setFileViewed(db, PR, SHA, ALICE, 'a.ts', false);
      expect(await getProgress(db, PR, SHA, ALICE)).toMatchObject({
        groupsReviewed: 0,
        viewedFiles: [],
      });
    });
  });

  describe('a new push (head sha changes)', () => {
    it('hides old state and discards it on the next write', async () => {
      const g = await createGroup(
        db,
        PR,
        SHA,
        { name: 'old', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      await setGroupReviewed(db, PR, SHA, g.id, ALICE, true);
      await setFileViewed(db, PR, SHA, ALICE, 'a.ts', true);

      // Reads at the new sha see nothing.
      expect(await listGroups(db, PR, NEW_SHA)).toEqual([]);
      expect(await getProgress(db, PR, NEW_SHA, ALICE)).toMatchObject({
        groupsTotal: 0,
        viewedFiles: [],
      });
      // An old group id can't be used at the new sha.
      expect(await setGroupReviewed(db, PR, NEW_SHA, g.id, ALICE, true)).toBe(
        false,
      );

      // That write discarded the old rows entirely.
      expect(await db.select().from(schema.reviewGroups)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupReviews)).toEqual([]);
      expect(await db.select().from(schema.reviewViewedFiles)).toEqual([]);
    });

    it('does not touch other PRs', async () => {
      await createGroup(db, OTHER_PR, SHA, { name: 'keep', files: [] }, ALICE);
      await setFileViewed(db, OTHER_PR, SHA, ALICE, 'a.ts', true);
      await createGroup(db, PR, NEW_SHA, { name: 'new', files: [] }, ALICE);
      expect((await listGroups(db, OTHER_PR, SHA))[0].name).toBe('keep');
      expect((await getProgress(db, OTHER_PR, SHA, ALICE)).viewedFiles).toEqual(
        ['a.ts'],
      );
    });
  });
});
