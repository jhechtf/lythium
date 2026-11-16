import { githubFetch, isGithubName, localFailure } from './github.ts';
import {
  type LookupFailure,
  REVIEW_LOOKUP_TIMEOUT_MS,
} from './review-context.ts';
import type { DiffFile } from './types.ts';

/** A file the PR changes, as GitHub's pulls files API reports it. */
export interface PRFile {
  path: string;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  /** Absent for binary files and for patches GitHub considers too large. */
  patch?: string;
  previousPath?: string;
}

/** GitHub's pulls files API returns at most 3000 files. */
export const MAX_PR_FILES = 3000;
const PAGE_SIZE = 100;

interface GithubPRFile {
  filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
  previous_filename?: unknown;
}

/**
 * Every file the PR changes, from `GET /pulls/{n}/files` with the caller's
 * token. Pages are fetched one after another (most PRs fit in one), up to
 * GitHub's own 3000-file cap. This reads the PR's current head, so a push
 * between this and `resolvePR` can make the two disagree; the write paths
 * catch that through `StaleHeadError`, and reads simply show the newer list.
 */
export async function fetchPRFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ ok: true; files: PRFile[] } | LookupFailure> {
  if (!isGithubName(owner) || !isGithubName(repo)) {
    return localFailure(400) as LookupFailure;
  }
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files`;
  const files: PRFile[] = [];
  for (let page = 1; page <= MAX_PR_FILES / PAGE_SIZE; page++) {
    const result = await githubFetch(
      `${base}?per_page=${PAGE_SIZE}&page=${page}`,
      token,
      REVIEW_LOOKUP_TIMEOUT_MS,
    );
    if (!result.ok) return result as LookupFailure;
    if (!Array.isArray(result.data)) return localFailure(502) as LookupFailure;
    const batch = result.data as GithubPRFile[];
    for (const f of batch) {
      if (typeof f.filename !== 'string') continue;
      files.push({
        path: f.filename,
        status: (typeof f.status === 'string'
          ? f.status
          : 'modified') as DiffFile['status'],
        additions: typeof f.additions === 'number' ? f.additions : 0,
        deletions: typeof f.deletions === 'number' ? f.deletions : 0,
        ...(typeof f.patch === 'string' && { patch: f.patch }),
        ...(typeof f.previous_filename === 'string' && {
          previousPath: f.previous_filename,
        }),
      });
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return { ok: true, files };
}

/** A file entry in a group, as the client sends it. */
export interface GroupFileInput {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
}

/**
 * Check group entries against the PR's changed files: every path must be in
 * the PR, and a line range (which refers to the new file) can't be on a file
 * the PR deletes. Returns an error message, or null if all are fine. Range
 * shape (both ends, start ≤ end) is checked by the data layer.
 */
export function checkFilesInPR(
  entries: GroupFileInput[],
  prFiles: PRFile[],
): string | null {
  const byPath = new Map(prFiles.map((f) => [f.path, f]));
  for (const e of entries) {
    const file = byPath.get(e.path);
    if (!file) return `${e.path} is not changed in this PR`;
    if (
      (e.startLine != null || e.endLine != null) &&
      file.status === 'removed'
    ) {
      return `${e.path} is deleted in this PR, so it has no lines to select`;
    }
  }
  return null;
}

/**
 * Changed files that no group mentions. A file counts as assigned as soon as
 * any group has it, whole or as a line range. Order follows the PR.
 */
export function unassignedFiles(
  prFiles: PRFile[],
  groups: { files: { path: string }[] }[],
): string[] {
  const assigned = new Set(groups.flatMap((g) => g.files.map((f) => f.path)));
  return prFiles.map((f) => f.path).filter((p) => !assigned.has(p));
}
