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

function toPRFile(f: GithubPRFile): PRFile | null {
  if (typeof f.filename !== 'string') return null;
  return {
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
  };
}

/**
 * Every file the PR changes, from `GET /pulls/{n}/files` with the caller's
 * token, up to GitHub's own 3000-file cap. Page 1 is fetched straight away
 * (most PRs fit in one). If it's full, the PR's `changed_files` count (from
 * `resolvePR`, which runs alongside) says how many pages remain, and those
 * are fetched in parallel. Without a count it falls back to paging serially.
 *
 * This reads the PR's current head, so a push between this and `resolvePR`
 * can make the two disagree; the write paths catch that through
 * `StaleHeadError`, and reads simply show the newer list.
 */
export async function fetchPRFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  changedFiles?: number | null | Promise<number | null>,
): Promise<{ ok: true; files: PRFile[] } | LookupFailure> {
  if (!isGithubName(owner) || !isGithubName(repo)) {
    return localFailure(400) as LookupFailure;
  }
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files`;
  const fetchPage = async (page: number) => {
    const result = await githubFetch(
      `${base}?per_page=${PAGE_SIZE}&page=${page}`,
      token,
      REVIEW_LOOKUP_TIMEOUT_MS,
    );
    if (!result.ok) return result as LookupFailure;
    if (!Array.isArray(result.data)) return localFailure(502) as LookupFailure;
    return { ok: true as const, batch: result.data as GithubPRFile[] };
  };
  const maxPages = MAX_PR_FILES / PAGE_SIZE;

  const first = await fetchPage(1);
  if (!first.ok) return first;
  const batches = [first.batch];
  if (first.batch.length === PAGE_SIZE) {
    const total = await changedFiles;
    if (typeof total === 'number') {
      const pages = Math.min(Math.ceil(total / PAGE_SIZE), maxPages);
      const rest = await Promise.all(
        Array.from({ length: Math.max(pages - 1, 0) }, (_, i) =>
          fetchPage(i + 2),
        ),
      );
      for (const r of rest) {
        if (!r.ok) return r;
        batches.push(r.batch);
      }
    } else {
      for (let page = 2; page <= maxPages; page++) {
        const r = await fetchPage(page);
        if (!r.ok) return r;
        batches.push(r.batch);
        if (r.batch.length < PAGE_SIZE) break;
      }
    }
  }
  const files = batches
    .flat()
    .map(toPRFile)
    .filter((f): f is PRFile => f !== null);
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
