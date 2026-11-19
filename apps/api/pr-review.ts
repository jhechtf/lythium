import { type Context, Hono } from 'hono';
import {
  githubErrorMessage,
  githubFetchAll,
  githubPost,
  upstreamError,
} from './github.ts';
import { fetchViewer, resolvePR } from './review-context.ts';
import {
  bearerToken,
  beforeBodyChecks,
  jsonBody,
  repoParams,
} from './route-params.ts';
import type {
  ReviewEvent,
  SubmitReviewErrorCode,
  SubmitReviewRequest,
  SubmitReviewResponse,
} from './types.ts';

/**
 * Submit a review on a PR (LYT-57): the review screens' "Finish Review".
 *
 * If the caller has a pending (draft) review on the PR, that review is
 * submitted, with the comments it holds. Otherwise a new review is created
 * and submitted in one call. Whether review comments are held in a pending
 * review or posted immediately is the comments API's choice (LYT-56); this
 * route works either way.
 */

const EVENTS: readonly ReviewEvent[] = [
  'APPROVE',
  'REQUEST_CHANGES',
  'COMMENT',
];

/** GitHub's limit on a review body. */
export const MAX_REVIEW_BODY = 65_536;

const SHA_RE = /^[0-9a-f]{40}$/i;

class BadRequest extends Error {}

export function parseSubmitReview(v: unknown): SubmitReviewRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new BadRequest('Body must be a JSON object');
  }
  const { event, body, commitId } = v as Record<string, unknown>;
  if (!EVENTS.includes(event as ReviewEvent)) {
    throw new BadRequest(`event must be one of ${EVENTS.join(', ')}`);
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new BadRequest('body must be a string');
  }
  if (typeof body === 'string' && body.length > MAX_REVIEW_BODY) {
    throw new BadRequest(`body must be at most ${MAX_REVIEW_BODY} characters`);
  }
  if (
    commitId !== undefined &&
    (typeof commitId !== 'string' || !SHA_RE.test(commitId))
  ) {
    throw new BadRequest('commitId must be a 40-character commit sha');
  }
  return {
    event: event as ReviewEvent,
    // An empty or blank summary is no summary.
    ...(typeof body === 'string' && body.trim() !== '' && { body }),
    ...(commitId !== undefined && { commitId: commitId.toLowerCase() }),
  };
}

interface GithubReviewSummary {
  id: number;
  state: string;
  user: { id: number } | null;
  /** The commit the review is attached to; fixed when a pending review is started. */
  commit_id?: string | null;
}

interface GithubSubmittedReview {
  id: number;
  state: string;
  body?: string | null;
  commit_id?: string | null;
  html_url?: string | null;
  submitted_at?: string | null;
}

const failure = (
  c: Context,
  status: 400 | 409 | 422,
  code: SubmitReviewErrorCode,
  error: string,
  extra: Record<string, unknown> = {},
) => c.json({ error, code, ...extra }, status);

// GitHub's wording for "you wrote this PR" ("Can not approve your own pull
// request", "Can not request changes on your own pull request").
const OWN_PR_RE = /your own pull request/i;

export const submitReviewRoutes = new Hono().post(
  '/reviews',
  ...beforeBodyChecks(1),
  async (c) => {
    let input: SubmitReviewRequest;
    try {
      input = parseSubmitReview(await jsonBody(c));
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
      throw err;
    }
    // `beforeBodyChecks` already validated these; this just reads them.
    const auth = bearerToken(c);
    const params = repoParams(c);
    if (auth.error) return auth.error;
    if ('error' in params) return params.error;
    const { token } = auth;
    const { owner, repo, pr_number, base } = params;

    const [resolved, viewer, reviews] = await Promise.all([
      resolvePR(token, owner, repo, Number(pr_number)),
      fetchViewer(token),
      // Pending reviews are visible only to their author. Read every page:
      // stopping early could miss the caller's pending review and create a
      // second review instead of submitting the one holding their comments.
      githubFetchAll<GithubReviewSummary>(
        `${base}/pulls/${pr_number}/reviews`,
        token,
        (d) => (Array.isArray(d) ? d : []),
        Number.POSITIVE_INFINITY,
      ),
    ]);
    if (!resolved.ok) return upstreamError(c, resolved, pr_number);
    if (!viewer.ok) return upstreamError(c, viewer, pr_number);
    if (!reviews.ok) return upstreamError(c, reviews.result, pr_number);

    const isAuthor =
      resolved.authorId !== null && resolved.authorId === viewer.viewer.id;
    if (isAuthor && input.event !== 'COMMENT') {
      return failure(
        c,
        422,
        'own_pr',
        input.event === 'APPROVE'
          ? "You can't approve your own pull request"
          : "You can't request changes on your own pull request",
      );
    }

    const headSha = resolved.pr.headSha.toLowerCase();
    if (input.commitId !== undefined && input.commitId !== headSha) {
      return failure(
        c,
        409,
        'stale_head',
        'The pull request has new commits since you reviewed it',
        { headSha },
      );
    }

    // GitHub allows one pending review per user per PR.
    const pending = reviews.items.find(
      (r) => r.state === 'PENDING' && r.user?.id === viewer.viewer.id,
    );

    // A pending review stays on the commit it was started on, and submitting
    // it can't move it. Approving or requesting changes through one started
    // before a push would put that verdict on code older than the head, so
    // only a comment review may publish it (its inline comments then show as
    // outdated, as on GitHub). A missing commit_id is treated as stale.
    const pendingCommit = pending?.commit_id?.toLowerCase() ?? null;
    if (pending && pendingCommit !== headSha && input.event !== 'COMMENT') {
      return failure(
        c,
        409,
        'stale_head',
        'Your pending review was started before the latest commits. Submit it as a comment, then review the new commits.',
        { headSha, pendingCommitId: pendingCommit },
      );
    }

    if (!pending && input.event !== 'APPROVE' && input.body === undefined) {
      return failure(
        c,
        400,
        'body_required',
        input.event === 'COMMENT'
          ? 'A comment review needs a summary'
          : 'Requesting changes needs a summary',
      );
    }

    const result = pending
      ? await githubPost(
          `${base}/pulls/${pr_number}/reviews/${pending.id}/events`,
          token,
          { event: input.event, ...(input.body && { body: input.body }) },
        )
      : await githubPost(`${base}/pulls/${pr_number}/reviews`, token, {
          event: input.event,
          // Pin the review to the head we checked, not whatever GitHub has
          // by the time this lands.
          commit_id: headSha,
          ...(input.body && { body: input.body }),
        });

    if (!result.ok) {
      if (result.status === 422) {
        const message = githubErrorMessage(result.data);
        return message && OWN_PR_RE.test(message)
          ? failure(c, 422, 'own_pr', message)
          : failure(
              c,
              422,
              'rejected',
              message ?? 'GitHub rejected the review',
            );
      }
      return upstreamError(c, result, pr_number);
    }

    const r = result.data as GithubSubmittedReview;
    return c.json<SubmitReviewResponse>({
      id: r.id,
      state: r.state,
      body: r.body ? r.body : null,
      commitId: r.commit_id ?? null,
      htmlUrl: r.html_url ?? null,
      submittedAt: r.submitted_at ?? null,
      fromPending: pending !== undefined,
    });
  },
);
