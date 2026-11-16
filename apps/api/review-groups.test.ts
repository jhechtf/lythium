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
import type { ReviewGroup, ReviewGroupsResponse } from './types.ts';

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

const GROUPS = `${PR_URL}/groups`;

async function create(body: unknown, token = 'author') {
  return app.request(GROUPS, as(token, 'POST', body));
}

async function list(token = 'author') {
  const res = await app.request(GROUPS, as(token));
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewGroupsResponse;
}

describe('review groups', () => {
  it('starts empty with every changed file unassigned', async () => {
    fakeGithub();
    expect(await list()).toEqual({
      headSha: SHA,
      groups: [],
      unassigned: ['api/a.ts', 'api/b.ts', 'web/c.svelte', 'old.ts'],
      totalFiles: 4,
    });
  });

  it('creates groups with whole files and line ranges', async () => {
    fakeGithub();
    const res = await create({
      name: 'Backend',
      files: [
        { path: 'api/a.ts' },
        { path: 'api/b.ts', startLine: 1, endLine: 4 },
      ],
    });
    expect(res.status).toBe(201);
    const group = (await res.json()) as ReviewGroup;
    expect(group).toMatchObject({
      name: 'Backend',
      position: 0,
      source: 'manual',
      createdBy: 1,
      files: [
        { path: 'api/a.ts', startLine: null, endLine: null },
        { path: 'api/b.ts', startLine: 1, endLine: 4 },
      ],
    });
    const out = await list('reviewer');
    expect(out.groups.map((g) => g.name)).toEqual(['Backend']);
    expect(out.unassigned).toEqual(['web/c.svelte', 'old.ts']);
  });

  it('rejects files the PR does not change, and ranges on deleted files', async () => {
    fakeGithub();
    const notInPR = await create({ name: 'x', files: [{ path: 'nope.ts' }] });
    expect(notInPR.status).toBe(400);
    expect(await notInPR.json()).toEqual({
      error: 'nope.ts is not changed in this PR',
    });
    const deleted = await create({
      name: 'x',
      files: [{ path: 'old.ts', startLine: 1, endLine: 2 }],
    });
    expect(deleted.status).toBe(400);
    // The whole deleted file is fine.
    expect(
      (await create({ name: 'x', files: [{ path: 'old.ts' }] })).status,
    ).toBe(201);
  });

  it('rejects malformed bodies with 400', async () => {
    fakeGithub();
    for (const body of [
      'not json',
      { files: [] },
      { name: 3 },
      { name: 'x', files: 'a.ts' },
      { name: 'x', files: [{ startLine: 1 }] },
      { name: 'x', files: [{ path: 'api/a.ts', startLine: '1', endLine: 2 }] },
      { name: 'x', files: [{ path: 'api/a.ts', startLine: 3, endLine: 1 }] },
      { name: '' },
    ]) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await list()).groups).toEqual([]);
  });

  it('only lets the author or a pusher change groups', async () => {
    const { gh } = fakeGithub();
    expect((await create({ name: 'x' }, 'reviewer')).status).toBe(403);
    gh.pushers.push('reviewer');
    expect((await create({ name: 'x' }, 'reviewer')).status).toBe(201);
  });

  it('renames, moves, and adds or removes files', async () => {
    fakeGithub();
    const a = (await (await create({ name: 'a' })).json()) as ReviewGroup;
    await create({ name: 'b' });
    const res = await app.request(
      `${GROUPS}/${a.id}`,
      as('author', 'PATCH', {
        name: 'renamed',
        position: 1,
        addFiles: [{ path: 'web/c.svelte', startLine: 2, endLine: 8 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: 'renamed',
      position: 1,
      files: [{ path: 'web/c.svelte', startLine: 2, endLine: 8 }],
    });
    expect((await list()).groups.map((g) => g.name)).toEqual(['b', 'renamed']);

    const removed = await app.request(
      `${GROUPS}/${a.id}`,
      as('author', 'PATCH', {
        removeFiles: [{ path: 'web/c.svelte', startLine: 2, endLine: 8 }],
      }),
    );
    expect(((await removed.json()) as ReviewGroup).files).toEqual([]);

    const bad = await app.request(
      `${GROUPS}/${a.id}`,
      as('author', 'PATCH', { addFiles: [{ path: 'nope.ts' }] }),
    );
    expect(bad.status).toBe(400);
  });

  it('only fetches the PR files when a patch adds files', async () => {
    const { fetchMock } = fakeGithub();
    const a = (await (await create({ name: 'a' })).json()) as ReviewGroup;
    fetchMock.mockClear();
    await app.request(
      `${GROUPS}/${a.id}`,
      as('author', 'PATCH', { name: 'b' }),
    );
    const paths = fetchMock.mock.calls.map(
      (c) => new URL(c[0] as string).pathname,
    );
    expect(paths.some((p) => p.endsWith('/files'))).toBe(false);
  });

  it('deletes a group', async () => {
    fakeGithub();
    const a = (await (await create({ name: 'a' })).json()) as ReviewGroup;
    const res = await app.request(`${GROUPS}/${a.id}`, as('author', 'DELETE'));
    expect(res.status).toBe(204);
    expect((await list()).groups).toEqual([]);
    const again = await app.request(
      `${GROUPS}/${a.id}`,
      as('author', 'DELETE'),
    );
    expect(again.status).toBe(404);
  });

  it('404s an unknown or malformed group id', async () => {
    fakeGithub();
    for (const id of ['999', 'abc', '0']) {
      const res = await app.request(
        `${GROUPS}/${id}`,
        as('author', 'PATCH', { name: 'x' }),
      );
      expect(res.status, id).toBe(404);
    }
  });

  it('replaces every group, e.g. when accepting AI groups', async () => {
    fakeGithub();
    await create({ name: 'manual' });
    const res = await app.request(
      GROUPS,
      as('author', 'PUT', {
        source: 'ai',
        groups: [
          { name: 'API', files: [{ path: 'api/a.ts' }, { path: 'api/b.ts' }] },
          {
            name: 'UI',
            description: 'Svelte',
            files: [{ path: 'web/c.svelte' }],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as ReviewGroupsResponse;
    expect(
      out.groups.map((g) => [g.name, g.position, g.source, g.createdBy]),
    ).toEqual([
      ['API', 0, 'ai', null],
      ['UI', 1, 'ai', null],
    ]);
    expect(out.unassigned).toEqual(['old.ts']);

    const bad = await app.request(
      GROUPS,
      as('author', 'PUT', { source: 'robot', groups: [] }),
    );
    expect(bad.status).toBe(400);
  });

  it('starts over after a push', async () => {
    const { gh } = fakeGithub();
    await create({ name: 'a' });
    gh.headSha = NEW_SHA;
    const out = await list();
    expect(out.headSha).toBe(NEW_SHA);
    expect(out.groups).toEqual([]);
  });

  it('maps GitHub failures and a missing token', async () => {
    fakeGithub({ failures: { '/repos/o/r/pulls/7/files': 404 } });
    expect((await app.request(GROUPS, as('author'))).status).toBe(404);
    expect((await app.request(GROUPS)).status).toBe(401);
    expect(
      (await app.request('/repos/gitlab/o/r/pr/7/groups', as('author'))).status,
    ).toBe(400);
  });

  it('answers 503 without a database', async () => {
    fakeGithub();
    setReviewDb(null);
    expect((await app.request(GROUPS, as('author'))).status).toBe(503);
  });

  it('pages through large PRs, fetching pages after the first in parallel', async () => {
    const { fetchMock } = fakeGithub({
      files: Array.from({ length: 250 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: 'modified',
      })),
    });
    const out = await list();
    expect(out.totalFiles).toBe(250);
    expect(out.unassigned[249]).toBe('f249.ts');
    const pages = fetchMock.mock.calls
      .map(([url]) => new URL(url as string))
      .filter((u) => u.pathname.endsWith('/files'))
      .map((u) => u.searchParams.get('page'));
    // changed_files says 3 pages, so there's no probe for an empty page 4.
    expect(pages.sort()).toEqual(['1', '2', '3']);
  });

  it('rejects an oversized body with 413, and a missing token before reading it', async () => {
    fakeGithub();
    const huge = JSON.stringify({
      name: 'x',
      description: 'x'.repeat(5 << 20),
    });
    const post = (headers: Record<string, string>) =>
      app.request(GROUPS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: huge,
      });
    const auth = { Authorization: 'Bearer author' };
    // Streamed (no Content-Length), and declared up front.
    expect((await post(auth)).status).toBe(413);
    expect(
      (await post({ ...auth, 'Content-Length': String(huge.length) })).status,
    ).toBe(413);
    expect((await post({})).status).toBe(401);
  });
});
