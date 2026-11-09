import type {
  MergeBlocker,
  MergeStatus,
  PRDetailsResponse,
  PRLatestCommit,
  PRReviewer,
  PRState,
  ReviewerState,
} from './types.ts';

export interface GithubPRFull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  labels: { name: string; color: string }[];
  requested_reviewers?: { login: string }[];
  requested_teams?: { slug: string }[];
  additions: number;
  deletions: number;
  changed_files: number;
  commits?: number;
}

export interface GithubReview {
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
}

export interface GithubCommit {
  sha: string;
  commit: {
    message: string;
    committer?: { date?: string } | null;
    author?: { date?: string } | null;
  };
}

export interface GithubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

export function mapState(pr: GithubPRFull): PRState {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'open';
}

/**
 * Collapse review history into one state per reviewer. Later APPROVED /
 * CHANGES_REQUESTED reviews replace earlier ones; COMMENTED never overrides
 * a decision and DISMISSED clears it. Only reviewers with an active review
 * request are `in_review`, so someone who merely commented (or whose review
 * was dismissed) is not reported as pending.
 */
export function mapReviewers(
  reviews: GithubReview[],
  requested: string[],
): PRReviewer[] {
  const byLogin = new Map<string, ReviewerState>();
  const ordered = [...reviews].sort((a, b) =>
    (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''),
  );
  for (const r of ordered) {
    const login = r.user?.login;
    if (!login) continue;
    switch (r.state.toUpperCase()) {
      case 'APPROVED':
        byLogin.set(login, 'approved');
        break;
      case 'CHANGES_REQUESTED':
        byLogin.set(login, 'changes_requested');
        break;
      case 'DISMISSED':
        byLogin.delete(login);
        break;
      // COMMENTED carries no decision: ignore it.
    }
  }
  // A re-request puts the reviewer back in review regardless of prior state.
  for (const login of requested) byLogin.set(login, 'in_review');
  return [...byLogin].map(([login, state]) => ({ login, state }));
}

export function mapLatestCommit(
  commit: GithubCommit | undefined,
): PRLatestCommit | null {
  if (!commit) return null;
  return {
    sha: commit.sha,
    short_sha: commit.sha.slice(0, 7),
    committed_at:
      commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
    message: commit.commit.message.split('\n')[0],
  };
}

export function computeMergeStatus(input: {
  pr: GithubPRFull;
  state: PRState;
  reviewers: PRReviewer[];
  checks: GithubCheckRun[] | null;
  parentPr: number | null;
}): MergeStatus {
  const { pr, state, reviewers, checks, parentPr } = input;
  const blocked_by: MergeBlocker[] = [];

  if (state === 'merged' || state === 'closed') {
    return {
      mergeable: false,
      blocked_by: [{ reason: 'closed', detail: state }],
    };
  }
  if (state === 'draft') blocked_by.push({ reason: 'draft' });
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    blocked_by.push({ reason: 'conflicts' });
  }
  // GitHub is still computing mergeability; don't claim the PR is mergeable.
  if (pr.mergeable === null)
    blocked_by.push({ reason: 'mergeability_unknown' });
  // `unstable` means only non-required checks are failing, so the merge is
  // still allowed. Skip them rather than reporting a false blocker.
  const failing =
    pr.mergeable_state === 'unstable'
      ? []
      : (checks ?? []).filter(
          (c) => c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion),
        );
  if (failing.length > 0) {
    blocked_by.push({
      reason: 'failing_checks',
      detail: failing.map((c) => c.name).join(', '),
    });
  }
  const changes = reviewers.filter((r) => r.state === 'changes_requested');
  if (changes.length > 0) {
    blocked_by.push({
      reason: 'changes_requested',
      detail: changes.map((r) => r.login).join(', '),
    });
  }
  const pending = reviewers.filter((r) => r.state === 'in_review');
  if (pending.length > 0) {
    blocked_by.push({
      reason: 'pending_reviews',
      detail: pending.map((r) => r.login).join(', '),
    });
  }
  if (parentPr !== null) {
    blocked_by.push({ reason: 'blocked_by_parent', detail: `#${parentPr}` });
  }
  // GitHub says blocked but we found no specific cause (e.g. required checks
  // not yet reported, required review count, branch rules).
  if (blocked_by.length === 0 && pr.mergeable_state === 'blocked') {
    blocked_by.push({ reason: 'branch_protection' });
  }

  return { mergeable: blocked_by.length === 0, blocked_by };
}

export function buildPRDetails(input: {
  pr: GithubPRFull;
  reviews: GithubReview[];
  latestCommit: GithubCommit | undefined;
  checks: GithubCheckRun[] | null;
  parentPr: number | null;
}): PRDetailsResponse {
  const { pr, reviews, latestCommit, checks, parentPr } = input;
  const state = mapState(pr);
  const requested = [
    ...(pr.requested_reviewers ?? []).map((r) => r.login),
    ...(pr.requested_teams ?? []).map((t) => `team:${t.slug}`),
  ];
  const reviewers = mapReviewers(reviews, requested);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    html_url: pr.html_url,
    state,
    author: pr.user?.login ?? null,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: pr.head.label },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: pr.base.label },
    labels: pr.labels.map((l) => ({ name: l.name, color: l.color })),
    reviewers,
    stats: {
      files_changed: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    latest_commit: mapLatestCommit(latestCommit),
    parent_pr: parentPr,
    merge: computeMergeStatus({ pr, state, reviewers, checks, parentPr }),
  };
}
