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
import type { Clusterer } from './clustering/clusterer.ts';
import { clearViewerCache, setReviewDb } from './review-context.ts';
import {
  GENERATE_RATE,
  getClusterer,
  resetGenerateState,
  setClusterer,
} from './review-generate.ts';
import { as, fakeGithub, NEW_SHA, PR_URL, SHA } from './review-test-utils.ts';
import type { GenerateGroupsResponse, ReviewGroupsResponse } from './types.ts';

let db: ReviewDb;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetReviewState(db);
  setReviewDb(db);
  resetGenerateState();
});
afterEach(() => {
  setReviewDb(undefined);
  setClusterer(undefined);
  clearViewerCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GENERATE = `${PR_URL}/groups/generate`;

/** One group per file, so results are easy to check. */
function modelClusterer() {
  const cluster = vi.fn<Clusterer['cluster']>(async (req) =>
    req.files.map((f) => ({
      name: `Group ${f.path}`,
      description: 'one file',
      fileIds: [f.id],
      confidence: 91,
    })),
  );
  const c: Clusterer = { name: 'test-model', cluster, merge: vi.fn() };
  setClusterer(c);
  return cluster;
}

const generate = (body: unknown, token = 'author') =>
  app.request(GENERATE, as(token, 'POST', body));

describe('POST …/groups/generate', () => {
  it('returns a preview covering every file, without saving it', async () => {
    fakeGithub();
    modelClusterer();
    const res = await generate({ strategy: 'feature' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as GenerateGroupsResponse;
    expect(out).toMatchObject({
      headSha: SHA,
      strategy: 'feature',
      granularity: 'balanced',
      generatedBy: 'model',
      model: 'test-model',
      fallbackReason: null,
      cached: false,
    });
    expect(out.groups.flatMap((g) => g.files).sort()).toEqual(
      ['api/a.ts', 'api/b.ts', 'old.ts', 'web/c.svelte'].sort(),
    );
    const saved = await app.request(`${PR_URL}/groups`, as('author'));
    expect(((await saved.json()) as ReviewGroupsResponse).groups).toEqual([]);
  });

  it('can be accepted through PUT …/groups', async () => {
    fakeGithub();
    modelClusterer();
    const preview = (await (
      await generate({ strategy: 'layer', granularity: 'fine' })
    ).json()) as GenerateGroupsResponse;
    const res = await app.request(
      `${PR_URL}/groups`,
      as('author', 'PUT', {
        source: 'ai',
        groups: preview.groups.map((g) => ({
          name: g.name,
          description: g.description,
          files: g.files.map((path) => ({ path })),
        })),
      }),
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()) as ReviewGroupsResponse;
    expect(saved.unassigned).toEqual([]);
    expect(saved.groups.every((g) => g.source === 'ai')).toBe(true);
  });

  it('caches by head sha and settings; regenerate makes a new one', async () => {
    const { gh } = fakeGithub();
    const cluster = modelClusterer();
    await generate({ strategy: 'feature' });
    const again = (await (
      await generate({ strategy: 'feature' })
    ).json()) as GenerateGroupsResponse;
    expect(again.cached).toBe(true);
    expect(cluster).toHaveBeenCalledTimes(1);

    await generate({ strategy: 'feature', granularity: 'coarse' });
    expect(cluster).toHaveBeenCalledTimes(2);
    const fresh = (await (
      await generate({ strategy: 'feature', regenerate: true })
    ).json()) as GenerateGroupsResponse;
    expect(fresh.cached).toBe(false);
    expect(cluster).toHaveBeenCalledTimes(3);

    gh.headSha = NEW_SHA;
    await generate({ strategy: 'feature' });
    expect(cluster).toHaveBeenCalledTimes(4);
  });

  it('rate-limits model generations per user, not cache hits', async () => {
    fakeGithub();
    modelClusterer();
    for (let i = 0; i < GENERATE_RATE.limit; i++) {
      const res = await generate({ strategy: 'feature', regenerate: true });
      expect(res.status).toBe(200);
    }
    const limited = await generate({ strategy: 'feature', regenerate: true });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
    // A cached preview is still served, and directory grouping is free.
    expect((await generate({ strategy: 'feature' })).status).toBe(200);
    expect((await generate({ strategy: 'directory' })).status).toBe(200);
  });

  it('falls back to directory grouping when no model is configured', async () => {
    fakeGithub();
    setClusterer(null);
    const out = (await (
      await generate({ strategy: 'feature' })
    ).json()) as GenerateGroupsResponse;
    expect(out).toMatchObject({
      generatedBy: 'directory',
      fallbackReason: 'not_configured',
      cached: false,
    });
    expect(out.groups.map((g) => g.name)).toEqual([
      'api',
      'Top-level files',
      'web',
    ]);
  });

  it('does not cache a fallback, so the next call retries the model', async () => {
    fakeGithub();
    const cluster = vi
      .fn<Clusterer['cluster']>()
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValue([]);
    setClusterer({ name: 'm', cluster, merge: vi.fn() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = (await (
      await generate({ strategy: 'feature' })
    ).json()) as GenerateGroupsResponse;
    expect(first.fallbackReason).toBe('model_error');
    const second = (await (
      await generate({ strategy: 'feature' })
    ).json()) as GenerateGroupsResponse;
    expect(second).toMatchObject({ generatedBy: 'model', cached: false });
    expect(cluster).toHaveBeenCalledTimes(2);
  });

  it('only lets the author or a pusher generate', async () => {
    fakeGithub();
    const cluster = modelClusterer();
    expect((await generate({ strategy: 'feature' }, 'reviewer')).status).toBe(
      403,
    );
    expect(cluster).not.toHaveBeenCalled();
  });

  it('400s bad settings', async () => {
    fakeGithub();
    modelClusterer();
    for (const body of [
      {},
      { strategy: 'magic' },
      { strategy: 'feature', granularity: 'huge' },
      { strategy: 'feature', regenerate: 'yes' },
    ]) {
      expect((await generate(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('getClusterer', () => {
  it('is null without an API key or with CLUSTER_PROVIDER=none', () => {
    setClusterer(undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLUSTER_PROVIDER', '');
    expect(getClusterer()).toBeNull();
    setClusterer(undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CLUSTER_PROVIDER', 'none');
    expect(getClusterer()).toBeNull();
  });

  it('uses Anthropic with the configured model when a key is set', () => {
    setClusterer(undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CLUSTER_PROVIDER', '');
    vi.stubEnv('CLUSTER_MODEL', 'some-model');
    expect(getClusterer()?.name).toBe('some-model');
  });
});
