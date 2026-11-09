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
