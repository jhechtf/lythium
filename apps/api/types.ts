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
/**
 * `unknown`: the check list was too long to fetch in full and nothing seen
 * failed or is running, so the PR can't be reported as passed.
 */
export type OverallCheckState =
  | 'passed'
  | 'running'
  | 'failed'
  | 'none'
  | 'unknown';

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
  /** True when GitHub had more checks than the API fetches (1000 per list). */
  truncated: boolean;
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

// ---------------------------------------------------------------------------
// Guided review: groups (LYT-61)
// ---------------------------------------------------------------------------

/** `manual` (made by a person) or `ai` (accepted from guided clustering). */
export type ReviewGroupSource = 'manual' | 'ai';

/** A file in a group. A line range refers to the new file; null for the whole file. */
export interface ReviewGroupFile {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewGroup {
  id: number;
  name: string;
  description: string | null;
  /** 0-based display order. */
  position: number;
  source: ReviewGroupSource;
  /** GitHub user id of whoever made it; null for AI-generated groups. */
  createdBy: number | null;
  files: ReviewGroupFile[];
}

/** `GET …/groups` and `PUT …/groups`. */
export interface ReviewGroupsResponse {
  /** Groups belong to this head sha; a push starts over with none. */
  headSha: string;
  groups: ReviewGroup[];
  /** Changed files no group mentions (whole or as a line range), in PR order. */
  unassigned: string[];
  /** Number of files the PR changes. */
  totalFiles: number;
}

/** A file entry in a request. Omit both lines for the whole file. */
export interface ReviewGroupFileInput {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
}

/** `POST …/groups`. */
export interface CreateReviewGroupRequest {
  name: string;
  description?: string | null;
  files?: ReviewGroupFileInput[];
}

/**
 * `PATCH …/groups/:id`. `files` replaces the list; `addFiles`/`removeFiles`
 * edit it in place and can't be sent with `files`. `position` moves the group
 * (past the end → last).
 */
export interface UpdateReviewGroupRequest {
  name?: string;
  description?: string | null;
  position?: number;
  files?: ReviewGroupFileInput[];
  addFiles?: ReviewGroupFileInput[];
  removeFiles?: ReviewGroupFileInput[];
}

/** `PUT …/groups`: replace every group, in order. */
export interface ReplaceReviewGroupsRequest {
  groups: CreateReviewGroupRequest[];
  /** Defaults to `manual`; send `ai` when accepting a generated preview. */
  source?: ReviewGroupSource;
}

// ---------------------------------------------------------------------------
// Guided review: progress (LYT-62). Private to the caller, reset by a push.
// ---------------------------------------------------------------------------

/** `GET …/progress`: "3 of 7 groups reviewed", "4 of 12 viewed". */
export interface ReviewProgressResponse {
  /** Progress belongs to this head sha; a push starts over. */
  headSha: string;
  groups: {
    total: number;
    reviewed: number;
    /** Ascending. */
    reviewedIds: number[];
  };
  files: {
    /** Files the PR changes. */
    total: number;
    /** Viewed files that are still in the PR. */
    viewed: number;
    /** Sorted. */
    viewedPaths: string[];
  };
}

/** `PUT …/groups/:id/reviewed`. */
export interface SetGroupReviewedRequest {
  reviewed: boolean;
}

/** `PUT …/files/viewed`. */
export interface SetFilesViewedRequest {
  paths: string[];
  viewed: boolean;
}

// ---------------------------------------------------------------------------
// Guided review: AI clustering (LYT-63). A preview; nothing is saved until
// the client sends the groups to `PUT …/groups` with `source: 'ai'`.
// ---------------------------------------------------------------------------

/**
 * `feature`: by user-facing change, across layers. `layer`: data → API → UI
 * → tests → docs/config. `directory`: by path, no model call.
 */
export type ClusterStrategy = 'feature' | 'layer' | 'directory';

/** Target group count: coarse 2–4, balanced 4–6, fine 6–10 (a hint to the model). */
export type ClusterGranularity = 'coarse' | 'balanced' | 'fine';

/** Why the result came from directory grouping instead of the model. */
export type GenerateFallbackReason =
  | 'not_configured'
  | 'refused'
  | 'model_error';

/** `POST …/groups/generate`. */
export interface GenerateGroupsRequest {
  strategy: ClusterStrategy;
  /** Defaults to `balanced`. */
  granularity?: ClusterGranularity;
  /** Skip the cached preview for these settings and generate a new one. */
  regenerate?: boolean;
}

export interface GeneratedGroup {
  name: string;
  description: string | null;
  /** Whole files; together the groups cover every changed file exactly once. */
  files: string[];
  /**
   * 0–100. From the model: its estimate that every file belongs under the
   * group's name. From directory grouping: 100 for a single directory, and
   * for the "Other changes" catch-all the share of its files in its most
   * common top-level directory. "Unsorted files" (files the model didn't
   * place) is 0.
   */
  confidence: number;
}

export interface GenerateGroupsResponse {
  /** The preview is for this head sha; accept it before the next push. */
  headSha: string;
  strategy: ClusterStrategy;
  granularity: ClusterGranularity;
  groups: GeneratedGroup[];
  generatedBy: 'model' | 'directory';
  /** Model id when `generatedBy` is `model`. */
  model: string | null;
  /** Set when a `feature`/`layer` request fell back to directory grouping. */
  fallbackReason: GenerateFallbackReason | null;
  /** True when this is a stored preview for the same head sha and settings. */
  cached: boolean;
}
