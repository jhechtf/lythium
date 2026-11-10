import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGroup,
  deleteGroup,
  getGroup,
  getProgress,
  listGroups,
  REVIEW_LIMITS,
  ReviewStateError,
  reorderGroups,
  replaceGroups,
  setFileViewed,
  setGroupReviewed,
  updateGroup,
  verifiedPR,
} from './review-state';
import * as schema from './schema';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

// One in-process Postgres with the real migrations applied, emptied per test.
async function migratedDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

const SHA = 'sha-1';
const NEW_SHA = 'sha-2';
const PR = verifiedPR({ owner: 'o', repo: 'r', prNumber: 7, headSha: SHA });
const OTHER_PR = verifiedPR({ ...PR, prNumber: 8 });
/** The same PR after a push. */
const PR_PUSHED = verifiedPR({ ...PR, headSha: NEW_SHA });
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
      const b = await createGroup(db, PR, { name: 'Tests', files: [] }, BOB);

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
      expect((await listGroups(db, PR)).map((g) => g.name)).toEqual([
        'API',
        'Tests',
      ]);
    });

    it('rejects half-open and inverted line ranges', async () => {
      await expect(
        createGroup(
          db,
          PR,
          { name: 'x', files: [{ path: 'a.ts', startLine: 3 }] },
          ALICE,
        ),
      ).rejects.toBeInstanceOf(ReviewStateError);
      await expect(
        createGroup(
          db,
          PR,
          { name: 'x', files: [{ path: 'a.ts', startLine: 9, endLine: 2 }] },
          ALICE,
        ),
      ).rejects.toBeInstanceOf(ReviewStateError);
      expect(await listGroups(db, PR)).toEqual([]);
    });

    it('updates name and replaces files', async () => {
      const g = await createGroup(
        db,
        PR,
        { name: 'old', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      const updated = await updateGroup(db, PR, g.id, {
        name: 'new',
        files: [{ path: 'b.ts', startLine: 1, endLine: 5 }],
      });
      expect(updated).toMatchObject({
        name: 'new',
        files: [{ path: 'b.ts', startLine: 1, endLine: 5 }],
      });
    });

    it('reorders groups and rejects an incomplete order', async () => {
      const a = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      const b = await createGroup(db, PR, { name: 'b', files: [] }, ALICE);
      const out = await reorderGroups(db, PR, [b.id, a.id]);
      expect(out.map((g) => g.name)).toEqual(['b', 'a']);
      await expect(reorderGroups(db, PR, [a.id])).rejects.toBeInstanceOf(
        ReviewStateError,
      );
    });

    it('deletes a group with its files and reviewed marks', async () => {
      const g = await createGroup(
        db,
        PR,
        { name: 'a', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      await setGroupReviewed(db, PR, g.id, ALICE, true);
      expect(await deleteGroup(db, PR, g.id)).toBe(true);
      expect(await listGroups(db, PR)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupFiles)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupReviews)).toEqual([]);
    });

    it('replaces all groups, e.g. on AI regeneration', async () => {
      await createGroup(db, PR, { name: 'manual', files: [] }, ALICE);
      const out = await replaceGroups(
        db,
        PR,
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
      const g = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      expect(await updateGroup(db, OTHER_PR, g.id, { name: 'x' })).toBe(null);
      expect(await deleteGroup(db, OTHER_PR, g.id)).toBe(false);
      expect(await setGroupReviewed(db, OTHER_PR, g.id, ALICE, true)).toBe(
        false,
      );
      expect((await listGroups(db, PR))[0].name).toBe('a');
    });
  });

  describe('progress', () => {
    it('keeps reviewed and viewed marks private to each user', async () => {
      const a = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      await createGroup(db, PR, { name: 'b', files: [] }, ALICE);
      await setGroupReviewed(db, PR, a.id, ALICE, true);
      await setFileViewed(db, PR, ALICE, 'a.ts', true);
      await setFileViewed(db, PR, ALICE, 'b.ts', true);

      expect(await getProgress(db, PR, ALICE)).toEqual({
        headSha: SHA,
        groupsTotal: 2,
        groupsReviewed: 1,
        reviewedGroupIds: [a.id],
        viewedFiles: ['a.ts', 'b.ts'],
      });
      expect(await getProgress(db, PR, BOB)).toMatchObject({
        groupsTotal: 2,
        groupsReviewed: 0,
        viewedFiles: [],
      });
    });

    it('marking twice is idempotent, and marks can be removed', async () => {
      const a = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      await setGroupReviewed(db, PR, a.id, ALICE, true);
      await setGroupReviewed(db, PR, a.id, ALICE, true);
      await setFileViewed(db, PR, ALICE, 'a.ts', true);
      await setFileViewed(db, PR, ALICE, 'a.ts', true);
      expect(await getProgress(db, PR, ALICE)).toMatchObject({
        groupsReviewed: 1,
        viewedFiles: ['a.ts'],
      });

      await setGroupReviewed(db, PR, a.id, ALICE, false);
      await setFileViewed(db, PR, ALICE, 'a.ts', false);
      expect(await getProgress(db, PR, ALICE)).toMatchObject({
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
        { name: 'old', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      await setGroupReviewed(db, PR, g.id, ALICE, true);
      await setFileViewed(db, PR, ALICE, 'a.ts', true);

      // Reads at the new sha see nothing.
      expect(await listGroups(db, PR_PUSHED)).toEqual([]);
      expect(await getProgress(db, PR_PUSHED, ALICE)).toMatchObject({
        groupsTotal: 0,
        viewedFiles: [],
      });
      // An old group id can't be used at the new sha.
      expect(await setGroupReviewed(db, PR_PUSHED, g.id, ALICE, true)).toBe(
        false,
      );

      // That write discarded the old rows entirely.
      expect(await db.select().from(schema.reviewGroups)).toEqual([]);
      expect(await db.select().from(schema.reviewGroupReviews)).toEqual([]);
      expect(await db.select().from(schema.reviewViewedFiles)).toEqual([]);
    });

    it('does not touch other PRs', async () => {
      await createGroup(db, OTHER_PR, { name: 'keep', files: [] }, ALICE);
      await setFileViewed(db, OTHER_PR, ALICE, 'a.ts', true);
      await createGroup(db, PR_PUSHED, { name: 'new', files: [] }, ALICE);
      expect((await listGroups(db, OTHER_PR))[0].name).toBe('keep');
      expect((await getProgress(db, OTHER_PR, ALICE)).viewedFiles).toEqual([
        'a.ts',
      ]);
    });
  });
  describe('review comment fixes', () => {
    it('only accepts a VerifiedPR, not a PR key with a client-supplied sha', () => {
      const fromRequest = { owner: 'o', repo: 'r', prNumber: 7, headSha: 'x' };
      // @ts-expect-error: a raw object can't stand in for a VerifiedPR.
      void listGroups(db, fromRequest);
    });

    it("replaceGroups attaches each group's files to the right group", async () => {
      const groups = Array.from({ length: 30 }, (_, i) => ({
        name: `g${i}`,
        files: [
          { path: `f${i}.ts` },
          { path: `f${i}.test.ts`, startLine: i + 1, endLine: i + 2 },
        ],
      }));
      const out = await replaceGroups(db, PR, groups, 'ai', null);
      expect(out).toHaveLength(30);
      for (const [i, g] of out.entries()) {
        expect(g.name).toBe(`g${i}`);
        expect(g.position).toBe(i);
        expect(g.files).toEqual([
          { path: `f${i}.ts`, startLine: null, endLine: null },
          { path: `f${i}.test.ts`, startLine: i + 1, endLine: i + 2 },
        ]);
      }
    });

    it('replaceGroups with no groups clears the PR', async () => {
      await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      expect(await replaceGroups(db, PR, [], 'ai', null)).toEqual([]);
    });

    it('reorders many groups in one statement', async () => {
      const ids: number[] = [];
      for (const name of ['a', 'b', 'c', 'd']) {
        ids.push((await createGroup(db, PR, { name, files: [] }, ALICE)).id);
      }
      const out = await reorderGroups(db, PR, [ids[2], ids[0], ids[3], ids[1]]);
      expect(out.map((g) => [g.name, g.position])).toEqual([
        ['c', 0],
        ['a', 1],
        ['d', 2],
        ['b', 3],
      ]);
    });

    it('getGroup reads one group and scopes it to the PR', async () => {
      const a = await createGroup(
        db,
        PR,
        { name: 'a', files: [{ path: 'a.ts' }] },
        ALICE,
      );
      await createGroup(
        db,
        PR,
        { name: 'b', files: [{ path: 'b.ts' }] },
        ALICE,
      );
      expect(await getGroup(db, PR, a.id)).toMatchObject({
        name: 'a',
        files: [{ path: 'a.ts', startLine: null, endLine: null }],
      });
      expect(await getGroup(db, OTHER_PR, a.id)).toBeNull();
      expect(await getGroup(db, PR_PUSHED, a.id)).toBeNull();
    });

    describe('input caps', () => {
      const L = REVIEW_LIMITS;
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ path: `f${i}` }));

      it.each([
        ['too many files', { name: 'x', files: many(L.filesPerGroup + 1) }],
        [
          'long path',
          { name: 'x', files: [{ path: 'p'.repeat(L.pathLength + 1) }] },
        ],
        ['long name', { name: 'n'.repeat(L.nameLength + 1), files: [] }],
        ['blank name', { name: '  ', files: [] }],
        [
          'long description',
          {
            name: 'x',
            description: 'd'.repeat(L.descriptionLength + 1),
            files: [],
          },
        ],
      ])('createGroup rejects %s', async (_, group) => {
        await expect(createGroup(db, PR, group, ALICE)).rejects.toBeInstanceOf(
          ReviewStateError,
        );
      });

      it('accepts values at the limits', async () => {
        const g = await createGroup(
          db,
          PR,
          {
            name: 'n'.repeat(L.nameLength),
            description: 'd'.repeat(L.descriptionLength),
            files: [{ path: 'p'.repeat(L.pathLength) }],
          },
          ALICE,
        );
        expect(g.files).toHaveLength(1);
      });

      it('replaceGroups caps groups and total files', async () => {
        await expect(
          replaceGroups(
            db,
            PR,
            Array.from({ length: L.groupsPerPR + 1 }, (_, i) => ({
              name: `g${i}`,
              files: [],
            })),
            'ai',
            null,
          ),
        ).rejects.toBeInstanceOf(ReviewStateError);
        await expect(
          replaceGroups(
            db,
            PR,
            Array.from({ length: 4 }, (_, i) => ({
              name: `g${i}`,
              files: many(L.filesPerGroup),
            })),
            'ai',
            null,
          ),
        ).rejects.toBeInstanceOf(ReviewStateError);
      });

      it('updateGroup and setFileViewed enforce the same caps', async () => {
        const g = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
        await expect(
          updateGroup(db, PR, g.id, { name: 'n'.repeat(L.nameLength + 1) }),
        ).rejects.toBeInstanceOf(ReviewStateError);
        await expect(
          setFileViewed(db, PR, ALICE, 'p'.repeat(L.pathLength + 1), true),
        ).rejects.toBeInstanceOf(ReviewStateError);
      });
    });
  });
});
