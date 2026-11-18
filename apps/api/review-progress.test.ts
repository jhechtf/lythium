import type { ReviewDb } from '@lythium/db';
import { createTestDb, resetReviewState } from '@lythium/db/testing';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { app } from './app.ts';
import { clearViewerCache, setReviewDb } from './review-context.ts';
import { as, fakeGithub, NEW_SHA, PR_URL, SHA } from './review-test-utils.ts';
import type { ReviewGroup, ReviewProgressResponse } from './types.ts';

let db: ReviewDb;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetReviewState(db);
  setReviewDb(db);
});
afterEach(() => {
  setReviewDb(undefined);
  clearViewerCache();
  vi.unstubAllGlobals();
});

async function newGroup(name: string) {
  const res = await app.request(
    `${PR_URL}/groups`,
    as('author', 'POST', { name }),
  );
  return (await res.json()) as ReviewGroup;
}

const markReviewed = (
  id: number | string,
  reviewed: unknown,
  token = 'reviewer',
) =>
  app.request(
    `${PR_URL}/groups/${id}/reviewed`,
    as(token, 'PUT', { reviewed }),
  );

const markViewed = (paths: unknown, viewed: unknown, token = 'reviewer') =>
  app.request(`${PR_URL}/files/viewed`, as(token, 'PUT', { paths, viewed }));

async function progress(token = 'reviewer') {
  const res = await app.request(`${PR_URL}/progress`, as(token));
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewProgressResponse;
}

describe('review progress', () => {
  it('starts at zero', async () => {
    fakeGithub();
    expect(await progress()).toEqual({
      headSha: SHA,
      groups: { total: 0, reviewed: 0, reviewedIds: [] },
      files: { total: 4, viewed: 0, viewedPaths: [] },
    });
  });

  it('marks and unmarks groups reviewed', async () => {
    fakeGithub();
    const a = await newGroup('a');
    const b = await newGroup('b');
    await newGroup('c');
    // Any reader can mark progress; it doesn't need push access.
    expect((await markReviewed(b.id, true)).status).toBe(204);
    expect((await markReviewed(a.id, true)).status).toBe(204);
    expect((await progress()).groups).toEqual({
      total: 3,
      reviewed: 2,
      reviewedIds: [a.id, b.id],
    });
    expect((await markReviewed(a.id, false)).status).toBe(204);
    expect((await progress()).groups.reviewed).toBe(1);
  });

  it('marks and unmarks files viewed, several at once', async () => {
    fakeGithub();
    expect((await markViewed(['api/a.ts', 'web/c.svelte'], true)).status).toBe(
      204,
    );
    expect((await progress()).files).toEqual({
      total: 4,
      viewed: 2,
      viewedPaths: ['api/a.ts', 'web/c.svelte'],
    });
    await markViewed(['api/a.ts'], false);
    expect((await progress()).files.viewedPaths).toEqual(['web/c.svelte']);
  });

  it('only counts viewed files that are still in the PR', async () => {
    const { gh } = fakeGithub();
    await markViewed(['api/a.ts', 'gone.ts'], true);
    expect((await progress()).files).toMatchObject({ viewed: 1 });
    gh.files = gh.files.filter((f) => f.filename !== 'api/a.ts');
    expect((await progress()).files).toMatchObject({ total: 3, viewed: 0 });
  });

  it('is private to each reviewer and survives a new session', async () => {
    const { gh } = fakeGithub();
    const a = await newGroup('a');
    await markReviewed(a.id, true);
    await markViewed(['api/a.ts'], true);
    expect((await progress('author')).groups.reviewed).toBe(0);
    expect((await progress('author')).files.viewed).toBe(0);
    // Same GitHub user, different token (another browser).
    gh.viewers['reviewer-laptop'] = gh.viewers.reviewer;
    clearViewerCache();
    expect(await progress('reviewer-laptop')).toMatchObject({
      groups: { reviewed: 1 },
      files: { viewed: 1 },
    });
  });

  it('resets after a push', async () => {
    const { gh } = fakeGithub();
    const a = await newGroup('a');
    await markReviewed(a.id, true);
    await markViewed(['api/a.ts'], true);
    gh.headSha = NEW_SHA;
    expect(await progress()).toEqual({
      headSha: NEW_SHA,
      groups: { total: 0, reviewed: 0, reviewedIds: [] },
      files: { total: 4, viewed: 0, viewedPaths: [] },
    });
  });

  it('404s an unknown group and 400s bad bodies', async () => {
    fakeGithub();
    expect((await markReviewed(999, true)).status).toBe(404);
    expect((await markReviewed('abc', true)).status).toBe(404);
    const a = await newGroup('a');
    expect((await markReviewed(a.id, 'yes')).status).toBe(400);
    expect((await markViewed('api/a.ts', true)).status).toBe(400);
    expect((await markViewed(['api/a.ts'], 1)).status).toBe(400);
    expect((await markViewed([3], true)).status).toBe(400);
  });

  it('404s a group id past the database integer range', async () => {
    fakeGithub();
    expect((await markReviewed(2147483647, true)).status).toBe(404);
    expect((await markReviewed(2147483648, true)).status).toBe(404);
    expect((await markReviewed(9999999999, true)).status).toBe(404);
  });

  describe('when the PR head moves during the files lookup', () => {
    /** Push a new head (and file list) right after each files response. */
    function pushAfterFiles(
      fake: ReturnType<typeof fakeGithub>,
      pushes: { sha: string; files: string[] }[],
    ) {
      const real = fake.fetchMock.getMockImplementation();
      if (!real) throw new Error('fake GitHub has no implementation');
      let next = 0;
      fake.fetchMock.mockImplementation(async (input, init) => {
        const res = await real(input, init);
        if (new URL(input).pathname.endsWith('/files') && pushes[next]) {
          const { sha, files } = pushes[next++];
          fake.gh.headSha = sha;
          fake.gh.files = files.map((filename) => ({
            filename,
            status: 'modified',
          }));
        }
        return res;
      });
    }

    it('looks both up again so the files match the reported head', async () => {
      const fake = fakeGithub();
      await markViewed(['api/a.ts'], true);
      pushAfterFiles(fake, [{ sha: NEW_SHA, files: ['x.ts', 'y.ts'] }]);
      const p = await progress();
      expect(p.headSha).toBe(NEW_SHA);
      expect(p.files).toEqual({ total: 2, viewed: 0, viewedPaths: [] });
    });

    it('answers 409 when the PR keeps moving', async () => {
      const fake = fakeGithub();
      const shas = ['c', 'd', 'e', 'f'].map((ch) => ch.repeat(40));
      pushAfterFiles(
        fake,
        shas.map((sha) => ({ sha, files: ['x.ts'] })),
      );
      const res = await app.request(`${PR_URL}/progress`, as('reviewer'));
      expect(res.status).toBe(409);
    });
  });

  it('does not fetch PR files to tick a file', async () => {
    const { fetchMock } = fakeGithub();
    await markViewed(['api/a.ts'], true);
    const paths = fetchMock.mock.calls.map(
      (c) => new URL(c[0] as string).pathname,
    );
    expect(paths.some((p) => p.endsWith('/files'))).toBe(false);
  });

  it('needs read access and a token', async () => {
    fakeGithub({ failures: { '/repos/o/r/pulls/7': 404 } });
    expect((await markViewed(['api/a.ts'], true)).status).toBe(404);
    expect((await app.request(`${PR_URL}/progress`)).status).toBe(401);
  });
});
