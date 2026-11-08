import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gitCommonDir } from './git.ts';

export interface BranchMeta {
  parent: string;
  prNumber?: number;
  prUrl?: string;
}

export interface LyStore {
  trunk: string;
  branches: Record<string, BranchMeta>;
}

export class LyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LyError';
  }
}

/**
 * Location of the persistent store. Anchored to the *shared* git directory
 * (`git rev-parse --git-common-dir`) rather than `<repoRoot>/.git`, so:
 *   - a bare clone works (there is no `<repoRoot>/.git`), and
 *   - every linked worktree sees the same stack metadata, instead of each
 *     worktree trying to write into its own `.git` file and failing.
 */
export function getStorePath(): string {
  return join(gitCommonDir(), 'ly', 'meta.json');
}

export function isInitialized(): boolean {
  try {
    return existsSync(getStorePath());
  } catch {
    return false;
  }
}

/**
 * Raw bytes of the store as this process last saw it — set by `load()` and
 * `save()`. `save()` compares it against the current file so a command that
 * loaded the store, then took a while (a `sync` rebase, say) while another
 * linked worktree wrote the shared store, fails loudly instead of renaming its
 * stale snapshot over the newer one and silently dropping that update.
 */
let lastSeenRaw: string | null = null;

export function load(): LyStore {
  const path = getStorePath();
  if (!existsSync(path)) {
    throw new LyError(
      'Lythium is not initialized in this repo. Run `ly init` first.',
    );
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(path, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    // A crash or Ctrl-C mid-write (or a botched hand-edit) can leave the file
    // truncated. Give a fixable message instead of a raw SyntaxError.
    throw new LyError(
      `Stack metadata at ${path} is not valid JSON. ` +
        'Fix it by hand or re-run `ly sync --rebuild`.',
    );
  }
  if (!isLyStore(parsed)) {
    throw new LyError(
      `Stack metadata at ${path} is malformed (bad trunk/branches or a branch record).`,
    );
  }
  lastSeenRaw = raw;
  return parsed;
}

function isBranchMeta(v: unknown): v is BranchMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<BranchMeta>;
  if (typeof m.parent !== 'string') return false;
  if (m.prNumber !== undefined && typeof m.prNumber !== 'number') return false;
  if (m.prUrl !== undefined && typeof m.prUrl !== 'string') return false;
  return true;
}

function isLyStore(v: unknown): v is LyStore {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<LyStore>;
  if (typeof s.trunk !== 'string') return false;
  // `typeof [] === 'object'`, but an array is not a `Record<string, BranchMeta>`:
  // consumers would treat numeric indexes as branch names. Reject it outright.
  if (
    typeof s.branches !== 'object' ||
    s.branches === null ||
    Array.isArray(s.branches)
  ) {
    return false;
  }
  // Every branch record must be well-formed: `getChildren()` and the stack
  // renderers dereference `meta.parent` unguarded, and a bad `prNumber`/`prUrl`
  // produces malformed PR links. Reject the whole file rather than crash later.
  return Object.values(s.branches).every(isBranchMeta);
}

// Max time to wait for another process/worktree to release the store lock
// before giving up.
const LOCK_TIMEOUT_MS = 5000;
// Poll interval while waiting for the lock.
const LOCK_RETRY_MS = 25;
// A lock file older than this is assumed to be left behind by a process that
// crashed (or was killed) before it could clean up, and is stolen rather than
// waited on forever.
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an exclusive, cross-process lock on the store file. Backed by
 * `open(..., 'wx')`, which the OS guarantees fails if the file already
 * exists — the same primitive `flock`/`O_EXCL`-based lockfile libraries use —
 * so concurrent `ly` processes (including ones in sibling worktrees sharing
 * this store) serialize instead of racing. Returns a release function that
 * must be called on every path, success or failure.
 */
function acquireLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone (e.g. stolen as stale by another process) — fine.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared between the failed create and this stat — retry.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LyError(
          `Could not acquire lock on stack metadata at ${path} ` +
            '(another `ly` process or worktree is holding it). Try again.',
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

export function save(store: LyStore): void {
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLock(path);
  try {
    // Lost-update guard: if the store on disk no longer matches what this
    // process loaded, another `ly` run (typically in a sibling worktree —
    // this whole feature is about sharing one store across worktrees) has
    // written it since. Renaming our snapshot over theirs would drop their
    // change without a trace, so refuse. The lock above ensures this check,
    // the write, and the rename all happen as one atomic unit with respect
    // to other `ly` processes.
    if (lastSeenRaw !== null && existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      if (current !== lastSeenRaw) {
        throw new LyError(
          `Stack metadata at ${path} changed while this command was running ` +
            '(another `ly` process or worktree wrote it). Re-run the command.',
        );
      }
    }
    // Write to a sibling temp file, then rename: a rename within a directory
    // is atomic, so an interrupted write never leaves a partial meta.json
    // behind for the next command — or another worktree sharing this store —
    // to hit.
    const tmp = `${path}.${process.pid}.tmp`;
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    writeFileSync(tmp, serialized, 'utf8');
    renameSync(tmp, path);
    lastSeenRaw = serialized;
  } finally {
    release();
  }
}

export function init(trunk: string): LyStore {
  const store: LyStore = { trunk, branches: {} };
  save(store);
  return store;
}
