import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGroup,
  deleteGroup,
  editablePR,
  getGroup,
  getProgress,
  listGroups,
  REVIEW_LIMITS,
  ReviewStateError,
  reorderGroups,
  replaceGroups,
  StaleHeadError,
  setFilesViewed,
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
// Editable, so the fixtures work for group writes and reads alike.
// Fixed observation times, so which request read GitHub first is explicit.
const T1 = new Date('2026-11-15T10:00:00Z');
const T2 = new Date('2026-11-15T10:01:00Z');
const PR = editablePR(
  verifiedPR({
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    headSha: SHA,
    observedAt: T1,
  }),
);
const OTHER_PR = editablePR(verifiedPR({ ...PR, prNumber: 8 }));
/** The same PR after a push, read from GitHub a minute later. */
const PR_PUSHED = editablePR(
  verifiedPR({ ...PR, headSha: NEW_SHA, observedAt: T2 }),
);
/** Readable but not editable: someone without push access who didn't write it. */
const READ_ONLY_PR = verifiedPR({ ...PR });
const ALICE = 101;
const BOB = 202;

describe('review state', () => {
  let db: Awaited<ReturnType<typeof migratedDb>>;
  beforeAll(async () => {
    db = await migratedDb();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate review_groups, review_group_files, review_group_reviews, review_viewed_files, review_pr_heads restart identity cascade`,
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

    it('adds and removes files in place, skipping duplicates', async () => {
      const g = await createGroup(
        db,
        PR,
        {
          name: 'g',
          files: [{ path: 'a.ts' }, { path: 'b.ts', startLine: 1, endLine: 9 }],
        },
        ALICE,
      );
      const out = await updateGroup(db, PR, g.id, {
        addFiles: [
          { path: 'a.ts' }, // already there
          { path: 'b.ts', startLine: 20, endLine: 30 },
          { path: 'c.ts' },
        ],
        removeFiles: [{ path: 'b.ts', startLine: 1, endLine: 9 }],
      });
      expect(out?.files).toEqual([
        { path: 'a.ts', startLine: null, endLine: null },
        { path: 'b.ts', startLine: 20, endLine: 30 },
        { path: 'c.ts', startLine: null, endLine: null },
      ]);
      // No range removes only the whole-file entry.
      const out2 = await updateGroup(db, PR, g.id, {
        removeFiles: [{ path: 'b.ts' }, { path: 'a.ts' }],
      });
      expect(out2?.files.map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
    });

    it('rejects files together with addFiles/removeFiles', async () => {
      const g = await createGroup(db, PR, { name: 'g', files: [] }, ALICE);
      await expect(
        updateGroup(db, PR, g.id, {
          files: [{ path: 'a.ts' }],
          addFiles: [{ path: 'b.ts' }],
        }),
      ).rejects.toBeInstanceOf(ReviewStateError);
    });

    it('caps files added in place', async () => {
      const g = await createGroup(
        db,
        PR,
        {
          name: 'g',
          files: Array.from(
            { length: REVIEW_LIMITS.filesPerGroup },
            (_, i) => ({
              path: `f${i}.ts`,
            }),
          ),
        },
        ALICE,
      );
      await expect(
        updateGroup(db, PR, g.id, { addFiles: [{ path: 'one-more.ts' }] }),
      ).rejects.toBeInstanceOf(ReviewStateError);
    });

    it('moves a group to a position', async () => {
      const a = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
      await createGroup(db, PR, { name: 'b', files: [] }, ALICE);
      const c = await createGroup(db, PR, { name: 'c', files: [] }, ALICE);
      await updateGroup(db, PR, c.id, { position: 0 });
      expect((await listGroups(db, PR)).map((g) => g.name)).toEqual([
        'c',
        'a',
        'b',
      ]);
      // Past the end means last.
      await updateGroup(db, PR, a.id, { position: 99 });
      expect(
        (await listGroups(db, PR)).map((g) => [g.name, g.position]),
      ).toEqual([
        ['c', 0],
        ['b', 1],
        ['a', 2],
      ]);
      await expect(
        updateGroup(db, PR, a.id, { position: -1 }),
      ).rejects.toBeInstanceOf(ReviewStateError);
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
    it('marks and unmarks several files at once', async () => {
      await setFilesViewed(db, PR, ALICE, ['a.ts', 'b.ts', 'a.ts'], true);
      await setFilesViewed(db, PR, ALICE, ['b.ts', 'c.ts'], true);
      expect((await getProgress(db, PR, ALICE)).viewedFiles).toEqual([
        'a.ts',
        'b.ts',
        'c.ts',
      ]);
      await setFilesViewed(db, PR, ALICE, ['a.ts', 'zzz.ts'], false);
      expect((await getProgress(db, PR, ALICE)).viewedFiles).toEqual([
        'b.ts',
        'c.ts',
      ]);
      expect((await getProgress(db, PR, BOB)).viewedFiles).toEqual([]);
    });

    it('rolls back a batch that would pass the viewed cap', async () => {
      const many = Array.from(
        { length: REVIEW_LIMITS.viewedFilesPerUser },
        (_, i) => `f${i}.ts`,
      );
      await setFilesViewed(db, PR, ALICE, many, true);
      await expect(
        setFilesViewed(db, PR, ALICE, ['x.ts', 'y.ts'], true),
      ).rejects.toBeInstanceOf(ReviewStateError);
      expect((await getProgress(db, PR, ALICE)).viewedFiles).toHaveLength(
        REVIEW_LIMITS.viewedFilesPerUser,
      );
      await expect(
        setFilesViewed(db, PR, ALICE, [...many, 'x.ts'], true),
      ).rejects.toBeInstanceOf(ReviewStateError);
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

    // A request reads the PR at the old head, then waits; a push lands and a
    // second request writes at the new head; the first one finally writes.
    it('rejects a write from before the push instead of deleting newer state', async () => {
      const fresh = await createGroup(
        db,
        PR_PUSHED,
        { name: 'new', files: [{ path: 'b.ts' }] },
        ALICE,
      );
      await setFileViewed(db, PR_PUSHED, ALICE, 'b.ts', true);

      // PR was observed at the old sha (T1), before PR_PUSHED's observation (T2).
      await expect(
        createGroup(db, PR, { name: 'late', files: [] }, BOB),
      ).rejects.toBeInstanceOf(StaleHeadError);
      await expect(
        setFileViewed(db, PR, BOB, 'a.ts', true),
      ).rejects.toBeInstanceOf(StaleHeadError);
      await expect(deleteGroup(db, PR, fresh.id)).rejects.toBeInstanceOf(
        StaleHeadError,
      );
      await expect(
        replaceGroups(db, PR, [], 'ai', null),
      ).rejects.toBeInstanceOf(StaleHeadError);

      // The newer state is untouched.
      expect((await listGroups(db, PR_PUSHED)).map((g) => g.id)).toEqual([
        fresh.id,
      ]);
      expect((await getProgress(db, PR_PUSHED, ALICE)).viewedFiles).toEqual([
        'b.ts',
      ]);
    });

    // Same-sha writes skip the discard, but must keep the newest observation
    // time: a different sha seen *between* two observations of this one is
    // older than the later of them and must not take over the head.
    it('keeps the newest observation time across same-sha writes', async () => {
      const at = (s: string) => new Date(`2026-11-15T10:${s}Z`);
      const obs = (headSha: string, t: Date) =>
        editablePR(verifiedPR({ ...PR, headSha, observedAt: t }));

      await createGroup(db, obs(SHA, at('00:00')), { name: 'a', files: [] }, 1);
      // A later read of the same sha moves the recorded time forward...
      await setFileViewed(db, obs(SHA, at('05:00')), ALICE, 'a.ts', true);
      // ...and an earlier one doesn't move it back.
      await setFileViewed(db, obs(SHA, at('01:00')), ALICE, 'b.ts', true);

      // A different sha read at 03:00 is older than the 05:00 read of SHA.
      await expect(
        createGroup(db, obs(NEW_SHA, at('03:00')), { name: 'x', files: [] }, 1),
      ).rejects.toBeInstanceOf(StaleHeadError);
      expect((await listGroups(db, PR)).map((g) => g.name)).toEqual(['a']);
      expect((await getProgress(db, PR, ALICE)).viewedFiles).toEqual([
        'a.ts',
        'b.ts',
      ]);

      // One read after the last SHA observation does take over.
      await createGroup(
        db,
        obs(NEW_SHA, at('06:00')),
        { name: 'n', files: [] },
        1,
      );
      expect(await listGroups(db, PR)).toEqual([]);
    });

    it('lets an older observation of the same sha through', async () => {
      await createGroup(db, PR_PUSHED, { name: 'a', files: [] }, ALICE);
      const sameShaEarlier = editablePR(
        verifiedPR({ ...PR, headSha: NEW_SHA, observedAt: T1 }),
      );
      await createGroup(db, sameShaEarlier, { name: 'b', files: [] }, ALICE);
      expect(await listGroups(db, PR_PUSHED)).toHaveLength(2);
    });

    it('follows the head back after a force-push to an earlier sha', async () => {
      await createGroup(db, PR, { name: 'old', files: [] }, ALICE);
      await createGroup(db, PR_PUSHED, { name: 'mid', files: [] }, ALICE);
      const T3 = new Date('2026-11-15T10:02:00Z');
      const back = editablePR(verifiedPR({ ...PR, observedAt: T3 }));
      await createGroup(db, back, { name: 'back', files: [] }, ALICE);
      // Only the group made at the head GitHub reported last survives.
      expect((await listGroups(db, back)).map((g) => g.name)).toEqual(['back']);
      expect(await listGroups(db, PR_PUSHED)).toEqual([]);
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
          { name: 'x', files: [{ path: 'p'.repeat(L.pathBytes + 1) }] },
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
            files: [{ path: 'p'.repeat(L.pathBytes) }],
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

      it('caps paths in bytes, not characters', async () => {
        // 'é' is 2 bytes in UTF-8: half the byte limit in characters is the max.
        const atLimit = 'é'.repeat(L.pathBytes / 2);
        const over = `${atLimit}x`;
        await setFileViewed(db, PR, ALICE, atLimit, true);
        expect((await getProgress(db, PR, ALICE)).viewedFiles).toEqual([
          atLimit,
        ]);
        await expect(
          setFileViewed(db, PR, ALICE, over, true),
        ).rejects.toBeInstanceOf(ReviewStateError);
        await expect(
          createGroup(db, PR, { name: 'x', files: [{ path: over }] }, ALICE),
        ).rejects.toBeInstanceOf(ReviewStateError);
      });

      it('caps viewed files per user, per PR', async () => {
        // Seed straight to the limit; one call per file would be slow.
        await db.insert(schema.reviewViewedFiles).values(
          Array.from({ length: L.viewedFilesPerUser }, (_, i) => ({
            owner: PR.owner,
            repo: PR.repo,
            prNumber: PR.prNumber,
            headSha: PR.headSha,
            userId: ALICE,
            path: `f${i}`,
          })),
        );
        await expect(
          setFileViewed(db, PR, ALICE, 'one-too-many', true),
        ).rejects.toBeInstanceOf(ReviewStateError);
        const { viewedFiles } = await getProgress(db, PR, ALICE);
        expect(viewedFiles).toHaveLength(L.viewedFilesPerUser);
        expect(viewedFiles).not.toContain('one-too-many');

        // Re-marking a viewed file, unmarking, and other users still work.
        await setFileViewed(db, PR, ALICE, 'f0', true);
        await setFileViewed(db, PR, BOB, 'one-too-many', true);
        await setFileViewed(db, PR, ALICE, 'f0', false);
        await setFileViewed(db, PR, ALICE, 'one-too-many', true);
        expect((await getProgress(db, PR, ALICE)).viewedFiles).toContain(
          'one-too-many',
        );
      });

      it('updateGroup and setFileViewed enforce the same caps', async () => {
        const g = await createGroup(db, PR, { name: 'a', files: [] }, ALICE);
        await expect(
          updateGroup(db, PR, g.id, { name: 'n'.repeat(L.nameLength + 1) }),
        ).rejects.toBeInstanceOf(ReviewStateError);
        await expect(
          setFileViewed(db, PR, ALICE, 'p'.repeat(L.pathBytes + 1), true),
        ).rejects.toBeInstanceOf(ReviewStateError);
      });
    });
  });

  describe('access', () => {
    it('only lets an EditablePR change shared groups', async () => {
      const g = await createGroup(db, PR, { name: 'A', files: [] }, ALICE);
      // Compile-time checks: a read-only PR can't reach group mutations.
      const blocked = () => [
        // @ts-expect-error VerifiedPR is not an EditablePR
        createGroup(db, READ_ONLY_PR, { name: 'B', files: [] }, BOB),
        // @ts-expect-error VerifiedPR is not an EditablePR
        replaceGroups(db, READ_ONLY_PR, [], 'manual', BOB),
        // @ts-expect-error VerifiedPR is not an EditablePR
        updateGroup(db, READ_ONLY_PR, g.id, { name: 'x' }),
        // @ts-expect-error VerifiedPR is not an EditablePR
        reorderGroups(db, READ_ONLY_PR, [g.id]),
        // @ts-expect-error VerifiedPR is not an EditablePR
        deleteGroup(db, READ_ONLY_PR, g.id),
      ];
      expect(typeof blocked).toBe('function');

      // Reads and the caller's own marks only need a VerifiedPR.
      expect(await listGroups(db, READ_ONLY_PR)).toHaveLength(1);
      expect(await setGroupReviewed(db, READ_ONLY_PR, g.id, BOB, true)).toBe(
        true,
      );
      await setFileViewed(db, READ_ONLY_PR, BOB, 'a.ts', true);
      expect(await getProgress(db, READ_ONLY_PR, BOB)).toMatchObject({
        reviewedGroupIds: [g.id],
        viewedFiles: ['a.ts'],
      });
    });
  });

  describe('write path consistency', () => {
    it('deleteGroup discards state from older shas like every other write', async () => {
      const g = await createGroup(db, PR, { name: 'A', files: [] }, ALICE);
      await setFileViewed(db, PR, ALICE, 'a.ts', true);

      // The PR moved on. A delete at the new sha finds nothing to delete, but
      // must still drop the old sha's groups and viewed marks.
      expect(await deleteGroup(db, PR_PUSHED, g.id)).toBe(false);
      expect(await db.select().from(schema.reviewGroups)).toHaveLength(0);
      expect(await db.select().from(schema.reviewViewedFiles)).toHaveLength(0);
    });

    it('deleteGroup still deletes a current group', async () => {
      const a = await createGroup(db, PR, { name: 'A', files: [] }, ALICE);
      const b = await createGroup(db, PR, { name: 'B', files: [] }, ALICE);
      expect(await deleteGroup(db, PR, a.id)).toBe(true);
      expect(await deleteGroup(db, PR, a.id)).toBe(false);
      expect((await listGroups(db, PR)).map((g) => g.id)).toEqual([b.id]);
    });

    it('treats owner and repo case-insensitively, like GitHub', async () => {
      const shouty = editablePR(
        verifiedPR({ owner: 'O', repo: 'R', prNumber: 7, headSha: SHA }),
      );
      expect(shouty.owner).toBe('o');
      expect(shouty.repo).toBe('r');

      const g = await createGroup(db, shouty, { name: 'A', files: [] }, ALICE);
      await setFileViewed(db, shouty, ALICE, 'a.ts', true);
      // Same PR under the other spelling: one set of groups and marks.
      expect((await listGroups(db, PR)).map((x) => x.id)).toEqual([g.id]);
      expect((await getProgress(db, PR, ALICE)).viewedFiles).toEqual(['a.ts']);
    });
  });

  // PGlite is one connection, so this can't reproduce the race; it checks the
  // advisory lock runs inside overlapping write transactions without error.
  it('gives overlapping creates unique positions', async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createGroup(db, PR, { name: `G${i}`, files: [] }, ALICE),
      ),
    );
    expect(new Set(made.map((g) => g.position)).size).toBe(5);
  });
});
