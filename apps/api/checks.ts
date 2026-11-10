import type {
  CheckState,
  OverallCheckState,
  PRCheck,
  PRChecksResponse,
} from './types.ts';

/** A check run from `GET /repos/{o}/{r}/commits/{sha}/check-runs`. */
export interface GithubCheckRunFull {
  id: number;
  name: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  details_url: string | null;
}

/** A commit status from `GET /repos/{o}/{r}/commits/{sha}/status`. */
export interface GithubCommitStatus {
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);
const SKIPPED_CONCLUSIONS = new Set(['skipped', 'stale']);

export function mapCheckRunState(
  status: string,
  conclusion: string | null,
): CheckState {
  if (status !== 'completed' || conclusion === null) return 'running';
  if (FAILED_CONCLUSIONS.has(conclusion)) return 'failed';
  if (SKIPPED_CONCLUSIONS.has(conclusion)) return 'skipped';
  // success and neutral both count as passing, as GitHub does for merging.
  return 'passed';
}

export function mapStatusState(state: GithubCommitStatus['state']): CheckState {
  if (state === 'pending') return 'running';
  if (state === 'success') return 'passed';
  return 'failed';
}

function secondsBetween(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
}

function shapeCheckRun(r: GithubCheckRunFull): PRCheck {
  const state = mapCheckRunState(r.status, r.conclusion);
  const completed_at = state === 'running' ? null : r.completed_at;
  return {
    name: r.name,
    source: 'check_run',
    status: r.status,
    conclusion: r.conclusion,
    state,
    started_at: r.started_at,
    completed_at,
    duration_seconds: secondsBetween(r.started_at, completed_at),
    url: r.html_url ?? r.details_url,
  };
}

/** Commit statuses carry no start time, so they never have a duration. */
function shapeStatus(s: GithubCommitStatus): PRCheck {
  const pending = s.state === 'pending';
  return {
    name: s.context,
    source: 'status',
    status: pending ? 'in_progress' : 'completed',
    conclusion: pending ? null : s.state,
    state: mapStatusState(s.state),
    started_at: null,
    completed_at: pending ? null : s.updated_at,
    duration_seconds: null,
    url: s.target_url,
  };
}

function overallState(counts: PRChecksResponse['counts']): OverallCheckState {
  if (counts.failed > 0) return 'failed';
  if (counts.running > 0) return 'running';
  if (counts.passed + counts.skipped > 0) return 'passed';
  return 'none';
}

export function buildPRChecks(input: {
  headSha: string;
  checkRuns: GithubCheckRunFull[];
  statuses: GithubCommitStatus[];
}): PRChecksResponse {
  const checks = [
    ...input.checkRuns.map(shapeCheckRun),
    ...input.statuses.map(shapeStatus),
  ];
  const counts = { passed: 0, running: 0, failed: 0, skipped: 0 };
  for (const c of checks) counts[c.state]++;

  // ISO-8601 UTC timestamps sort lexically.
  const starts = checks.flatMap((c) => (c.started_at ? [c.started_at] : []));
  const ends = checks.flatMap((c) => (c.completed_at ? [c.completed_at] : []));
  const anyRunning = counts.running > 0;

  return {
    state: overallState(counts),
    counts,
    total: checks.length,
    build: {
      sha: input.headSha,
      short_sha: input.headSha.slice(0, 7),
      started_at: starts.length ? starts.sort()[0] : null,
      completed_at:
        !anyRunning && ends.length ? ends.sort()[ends.length - 1] : null,
    },
    checks,
  };
}
