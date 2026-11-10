export interface GitHubRef {
  ref: string;
  sha: string;
  label: string;
}

export interface StackPR {
  number: number;
  title: string;
  html_url: string;
  head: GitHubRef;
  base: GitHubRef;
}

export interface DiffFile {
  filename: string;
  status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface StackDiff {
  stats: {
    ahead_by: number;
    behind_by: number;
    total_commits: number;
  };
  files: DiffFile[];
}

export interface StackItem {
  pr: StackPR;
  diff: StackDiff;
}

export interface StackDiffResponse {
  stack: StackItem[];
}

export type PRState = 'open' | 'draft' | 'closed' | 'merged';

export type ReviewerState = 'in_review' | 'approved' | 'changes_requested';

export interface PRReviewer {
  login: string;
  state: ReviewerState;
}

export type MergeBlockReason =
  | 'draft'
  | 'closed'
  | 'conflicts'
  /** GitHub hasn't finished computing mergeability yet (`mergeable: null`). */
  | 'mergeability_unknown'
  | 'failing_checks'
  | 'pending_reviews'
  | 'changes_requested'
  | 'blocked_by_parent'
  | 'branch_protection';

export interface MergeBlocker {
  reason: MergeBlockReason;
  detail?: string;
}

export interface MergeStatus {
  /** True only when the PR is open, not draft, and nothing blocks it. */
  mergeable: boolean;
  blocked_by: MergeBlocker[];
}

export interface PRLatestCommit {
  sha: string;
  short_sha: string;
  committed_at: string | null;
  message: string;
}

/** Normalized state of one check. */
export type CheckState = 'passed' | 'running' | 'failed' | 'skipped';

/**
 * Overall CI state: `failed` if any check failed, else `running` if any is
 * still going, else `passed`. `none` means the head sha has no checks.
 */
export type OverallCheckState = 'passed' | 'running' | 'failed' | 'none';

export interface PRCheck {
  name: string;
  /** `check_run` (Checks API) or `status` (legacy commit status). */
  source: 'check_run' | 'status';
  /** GitHub's raw status, e.g. `queued`, `in_progress`, `completed`. */
  status: string;
  /** GitHub's raw conclusion; null until the check completes. */
  conclusion: string | null;
  state: CheckState;
  started_at: string | null;
  completed_at: string | null;
  /** Null while running, and always null for commit statuses. */
  duration_seconds: number | null;
  url: string | null;
}

export interface PRChecksResponse {
  state: OverallCheckState;
  counts: Record<CheckState, number>;
  total: number;
  /** The build is the set of checks on the PR's head sha. */
  build: {
    sha: string;
    short_sha: string;
    /** Earliest check start. */
    started_at: string | null;
    /** Latest check finish; null while any check is running. */
    completed_at: string | null;
  };
  checks: PRCheck[];
}

export interface PRDetailsResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: PRState;
  author: string | null;
  head: GitHubRef;
  base: GitHubRef;
  labels: { name: string; color: string }[];
  reviewers: PRReviewer[];
  stats: { files_changed: number; additions: number; deletions: number };
  latest_commit: PRLatestCommit | null;
  /** Number of the open PR whose head is this PR's base, when stacked. */
  parent_pr: number | null;
  merge: MergeStatus;
}
