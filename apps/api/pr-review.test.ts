import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import { githubErrorMessage } from './github.ts';
import { MAX_REVIEW_BODY, parseSubmitReview } from './pr-review.ts';
import { clearViewerCache } from './review-context.ts';
import { AUTHOR, as, PR_URL, REVIEWER, SHA } from './review-test-utils.ts';
import type { SubmitReviewResponse } from './types.ts';

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

interface FakeOptions {
  /** Reviews `GET …/reviews` returns. */
  reviews?: {
    id: number;
    state: string;
    user: { id: number } | null;
    commit_id?: string;
  }[];
  /** Answer the review POST with this status and body instead of success. */
  postFailure?: { status: number; body: unknown; headers?: HeadersInit };
}

/** A fake GitHub for the review route: PR, viewer, reviews list, and the two review writes. */
function fakeReviewGithub(opts: FakeOptions = {}) {
  const posted: Posted[] = [];
  const viewers: Record<string, number> = {
    author: AUTHOR,
    reviewer: REVIEWER,
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const token = (
      (init?.headers as Record<string, string>)?.Authorization ?? ''
    ).replace('Bearer ', '');
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status });
    const path = url.pathname;

    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push({ path, body });
      if (opts.postFailure) {
        return new Response(JSON.stringify(opts.postFailure.body), {
          status: opts.postFailure.status,
          headers: opts.postFailure.headers,
        });
      }
      const pendingId = path.match(/\/reviews\/(\d+)\/events$/)?.[1];
      const state = {
        APPROVE: 'APPROVED',
        REQUEST_CHANGES: 'CHANGES_REQUESTED',
        COMMENT: 'COMMENTED',
      }[body.event as string];
      return json({
        id: pendingId ? Number(pendingId) : 99,
        state,
        body: body.body ?? '',
        commit_id: body.commit_id ?? SHA,
        html_url: 'https://github.com/o/r/pull/7#pullrequestreview-99',
        submitted_at: '2026-11-18T00:00:00Z',
      });
    }
    if (path === '/user') {
      const id = viewers[token];
      return id === undefined
        ? new Response('bad', { status: 401 })
        : json({ id, login: token });
    }
    if (path === '/repos/o/r/pulls/7') {
      return json({
        head: { sha: SHA },
        user: { id: AUTHOR },
        base: { sha: 'c'.repeat(40), repo: { permissions: { push: false } } },
      });
    }
    if (path === '/repos/o/r/pulls/7/reviews') {
      return json(opts.reviews ?? []);
    }
    return new Response('not stubbed', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted, fetchMock };
}

const submit = (body: unknown, token = 'reviewer') =>
  app.request(`${PR_URL}/reviews`, as(token, 'POST', body));

afterEach(() => {
  clearViewerCache();
  vi.unstubAllGlobals();
});

describe('POST …/reviews', () => {
  it.each([
    ['APPROVE', undefined, 'APPROVED'],
    ['REQUEST_CHANGES', 'Please fix the null check', 'CHANGES_REQUESTED'],
    ['COMMENT', 'Looks reasonable so far', 'COMMENTED'],
  ])('submits a %s review', async (event, summary, state) => {
    const { posted } = fakeReviewGithub();
    const res = await submit({ event, body: summary });
    expect(res.status).toBe(200);
    const out = (await res.json()) as SubmitReviewResponse;
    expect(out).toMatchObject({
      id: 99,
      state,
      body: summary ?? null,
      commitId: SHA,
      fromPending: false,
    });
    expect(posted).toEqual([
      {
        path: '/repos/o/r/pulls/7/reviews',
        body: {
          event,
          commit_id: SHA,
          ...(summary && { body: summary }),
        },
      },
    ]);
  });

  it('sends a summary with an approval', async () => {
    const { posted } = fakeReviewGithub();
    const res = await submit({ event: 'APPROVE', body: 'Ship it' });
    expect(res.status).toBe(200);
    expect(posted[0].body.body).toBe('Ship it');
  });

  it('drops a blank summary', async () => {
    const { posted } = fakeReviewGithub();
    await submit({ event: 'APPROVE', body: '   ' });
    expect(posted[0].body).not.toHaveProperty('body');
  });

  it("submits the caller's pending review with its comments", async () => {
    const { posted } = fakeReviewGithub({
      reviews: [
        { id: 5, state: 'COMMENTED', user: { id: REVIEWER } },
        { id: 12, state: 'PENDING', user: { id: REVIEWER } },
      ],
    });
    // A comment review needs no summary when the pending review holds comments.
    const res = await submit({ event: 'COMMENT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 12, fromPending: true });
    expect(posted).toEqual([
      {
        path: '/repos/o/r/pulls/7/reviews/12/events',
        body: { event: 'COMMENT' },
      },
    ]);
  });

  it("ignores someone else's pending review", async () => {
    const { posted } = fakeReviewGithub({
      reviews: [{ id: 12, state: 'PENDING', user: { id: 555 } }],
    });
    const res = await submit({ event: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(posted[0].path).toBe('/repos/o/r/pulls/7/reviews');
  });

  it('approves through a pending review started on the current head', async () => {
    const { posted } = fakeReviewGithub({
      reviews: [
        { id: 12, state: 'PENDING', commit_id: SHA, user: { id: REVIEWER } },
      ],
    });
    const res = await submit({ event: 'APPROVE', commitId: SHA });
    expect(res.status).toBe(200);
    expect(posted[0].path).toBe('/repos/o/r/pulls/7/reviews/12/events');
  });

  describe('a pending review started before the latest push', () => {
    const OLD = 'd'.repeat(40);
    const stale = () =>
      fakeReviewGithub({
        reviews: [
          { id: 12, state: 'PENDING', commit_id: OLD, user: { id: REVIEWER } },
        ],
      });

    it.each([
      'APPROVE',
      'REQUEST_CHANGES',
    ])('refuses %s, with or without commitId', async (event) => {
      const { posted } = stale();
      for (const commitId of [undefined, SHA]) {
        const res = await submit({ event, body: 'x', commitId });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
          code: 'stale_head',
          headSha: SHA,
          pendingCommitId: OLD,
        });
      }
      expect(posted).toEqual([]);
    });

    it('can still be published as a comment review', async () => {
      const { posted } = stale();
      const res = await submit({ event: 'COMMENT' });
      expect(res.status).toBe(200);
      expect(posted[0].path).toBe('/repos/o/r/pulls/7/reviews/12/events');
    });

    it('treats a pending review without a commit as stale', async () => {
      fakeReviewGithub({
        reviews: [{ id: 12, state: 'PENDING', user: { id: REVIEWER } }],
      });
      const res = await submit({ event: 'APPROVE' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ pendingCommitId: null });
    });
  });

  it.each([
    'APPROVE',
    'REQUEST_CHANGES',
  ])('refuses %s from the PR author without calling GitHub', async (event) => {
    const { posted } = fakeReviewGithub();
    const res = await submit({ event, body: 'x' }, 'author');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'own_pr' });
    expect(posted).toEqual([]);
  });

  it('lets the author leave a comment review', async () => {
    fakeReviewGithub();
    const res = await submit({ event: 'COMMENT', body: 'Note' }, 'author');
    expect(res.status).toBe(200);
  });

  it.each([
    'REQUEST_CHANGES',
    'COMMENT',
  ])('requires a summary for %s without a pending review', async (event) => {
    const { posted } = fakeReviewGithub();
    const res = await submit({ event });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'body_required' });
    expect(posted).toEqual([]);
  });

  it('answers 409 when the PR moved past the reviewed commit', async () => {
    const { posted } = fakeReviewGithub();
    const res = await submit({ event: 'APPROVE', commitId: 'f'.repeat(40) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'stale_head',
      headSha: SHA,
    });
    expect(posted).toEqual([]);
  });

  it('accepts the current head as commitId, in any case', async () => {
    fakeReviewGithub();
    const res = await submit({ event: 'APPROVE', commitId: SHA.toUpperCase() });
    expect(res.status).toBe(200);
  });

  it("maps GitHub's own-PR refusal to own_pr", async () => {
    fakeReviewGithub({
      postFailure: {
        status: 422,
        body: {
          message: 'Unprocessable Entity',
          errors: ['Can not approve your own pull request'],
        },
      },
    });
    const res = await submit({ event: 'APPROVE' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: 'own_pr',
      error: 'Can not approve your own pull request',
    });
  });

  it("passes any other GitHub 422 through as rejected with GitHub's reason", async () => {
    fakeReviewGithub({
      postFailure: {
        status: 422,
        body: { message: 'Pull request is closed' },
      },
    });
    const res = await submit({ event: 'APPROVE' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: 'rejected',
      error: 'Pull request is closed',
    });
  });

  it('answers 403 when the token may not review', async () => {
    fakeReviewGithub({
      postFailure: {
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      },
    });
    const res = await submit({ event: 'APPROVE' });
    expect(res.status).toBe(403);
  });

  it('answers 429 on a GitHub rate limit', async () => {
    fakeReviewGithub({
      postFailure: {
        status: 403,
        body: { message: 'rate limited' },
        headers: { 'Retry-After': '30' },
      },
    });
    const res = await submit({ event: 'APPROVE' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('answers 404 when the caller cannot see the PR', async () => {
    const { posted } = fakeReviewGithub();
    const res = await app.request(
      '/repos/github/o/r/pr/8/reviews',
      as('reviewer', 'POST', { event: 'APPROVE' }),
    );
    expect(res.status).toBe(404);
    expect(posted).toEqual([]);
  });

  it('rejects a request without a token before reading the body', async () => {
    const { fetchMock } = fakeReviewGithub();
    const res = await app.request(`${PR_URL}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ event: 'APPROVE' }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid body with 400', async () => {
    const { fetchMock } = fakeReviewGithub();
    const res = await app.request(`${PR_URL}/reviews`, {
      method: 'POST',
      headers: { Authorization: 'Bearer reviewer' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect((await submit({ event: 'MERGE' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseSubmitReview', () => {
  it.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{}, /event/],
    [{ event: 'approve' }, /event/],
    [{ event: 'APPROVE', body: 3 }, /body/],
    [{ event: 'APPROVE', body: 'x'.repeat(MAX_REVIEW_BODY + 1) }, /at most/],
    [{ event: 'APPROVE', commitId: 'abc' }, /commitId/],
  ])('rejects %j', (input, message) => {
    expect(() => parseSubmitReview(input)).toThrow(message);
  });

  it('accepts a full request and lowercases the sha', () => {
    expect(
      parseSubmitReview({
        event: 'COMMENT',
        body: 'hi',
        commitId: 'A'.repeat(40),
      }),
    ).toEqual({ event: 'COMMENT', body: 'hi', commitId: 'a'.repeat(40) });
  });

  it('treats a null body as no body', () => {
    expect(parseSubmitReview({ event: 'APPROVE', body: null })).toEqual({
      event: 'APPROVE',
    });
  });
});

describe('githubErrorMessage', () => {
  it.each([
    [
      JSON.stringify({ message: 'Validation Failed', errors: ['a', 'b'] }),
      'a; b',
    ],
    [
      JSON.stringify({
        message: 'Validation Failed',
        errors: [{ message: 'c' }],
      }),
      'c',
    ],
    [
      JSON.stringify({ message: 'Pull request is closed' }),
      'Pull request is closed',
    ],
    [JSON.stringify({ message: 'm', errors: [{ code: 'invalid' }] }), 'm'],
    ['<html>bad gateway</html>', null],
    [null, null],
  ])('%s → %s', (data, expected) => {
    expect(githubErrorMessage(data)).toBe(expected);
  });
});
