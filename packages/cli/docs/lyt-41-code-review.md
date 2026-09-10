# LYT-41 code review — bare clone + multi-worktree support

**Scope:** `main...jhechtf/lyt-41-cli-detect-multiple-worktrees-on-a-bare-git-clone`
(commits `7f919af`, `3efccd4`) — `src/git.ts`, `src/store.ts`, `src/worktree.ts`,
the six command call sites, and the new tests/helpers.
**Reviewed:** 2026-09-09 · git 2.42.0.windows.1

## Verdict

The design is right: parse `git worktree list --porcelain -z` once, anchor the store
to `--git-common-dir`, and fail *before* mutating anything. `listWorktrees()` and the
guard helpers correctly use `gitArgs` (argv, no shell), and the CodeRabbit fixes
(`-z` delimiting, guard-before-`updateTrunk`) landed properly.

Two things block merge:

1. **`ly sync` still cannot run in the layout this PR adds support for** — the guard
   skips trunk, and `updateTrunk()` then hits a hard git failure. (§1)
2. **Making the store genuinely shared across worktrees introduced a
   concurrent-write data-loss window** that did not exist before, because each
   worktree previously had its own (broken) path. (§2)

Separately, §3 is a pre-existing shell-injection chain that this branch's own
`CLAUDE.md` text ("use `gitArgs` for any value that is not a trusted, validated ref")
describes but does not enforce. It is reachable from `ly sync --rebuild` and is the
highest-severity item in the file, so it is documented here even though it is not new.

---

## 1. BLOCKER — `ly sync` fails in a bare + multi-worktree repo (trunk is not guarded)

**Where:** [sync.ts:273](../src/commands/sync.ts#L273), [git.ts:238-249](../src/git.ts#L238-L249),
[sync.ts:381](../src/commands/sync.ts#L381)

`guardBranchesAvailable(Object.keys(store.branches))` covers every *tracked* branch —
but trunk is never a key in `store.branches`. `create.ts:96` and `track.ts:56` only
add feature branches, and `rebuildStore()` returns trunk as a separate `trunk` field
([sync.ts:182](../src/commands/sync.ts#L182)). So the guard passes, and control falls
straight into:

```ts
export function updateTrunk(trunk: string): void {
  if (currentBranch() === trunk) {
    gitArgs(['merge', '--ff-only', `origin/${trunk}`]);
  } else {
    gitArgs(['merge-base', '--is-ancestor', trunk, `origin/${trunk}`]);
    gitArgs(['branch', '-f', trunk, `origin/${trunk}`]);   // <-- fatal
  }
}
```

In the canonical bare layout, trunk lives in its own worktree (`main/`), so any
`ly sync` run from a feature worktree takes the `else` branch. Verified directly:

```
$ git branch -f main HEAD          # from worktree `f`, main checked out in `m`
fatal: cannot force update the branch 'main' used by worktree at '.../m'
rc=128
```

`sync` catches this, prints `Could not fast-forward main: …`, and exits 1
([sync.ts:279-290](../src/commands/sync.ts#L279-L290)). Net effect: `ly sync` is
unusable in the exact configuration the PR is titled after, and the failure message
points at trunk rather than at the worktree layout, so the cause is not obvious.

Same gap at the tail of `sync`: [sync.ts:381](../src/commands/sync.ts#L381)
`checkout(listLocalBranches().includes(origin) ? origin : store.trunk)` — if the
branch you started on was just deleted as merged, sync tries to check out trunk and
dies *after* every mutation has landed.

### Fix

Guard trunk too, with a message that fits trunk, and fast-forward it in place rather
than refusing:

```ts
// sync.ts, replacing the single guard call
const trunkWorktree = branchCheckedOutElsewhere(store.trunk);
guardBranchesAvailable(Object.keys(store.branches));
// …then pass trunkWorktree into updateTrunk below.
```

```ts
// git.ts
/**
 * Fast-forward the local trunk to `origin/<trunk>`.
 * `inWorktree` is the path of the worktree that has trunk checked out, when that
 * is not the current one: `git branch -f` refuses to move a branch another
 * worktree is using, so drive the merge inside that worktree instead.
 */
export function updateTrunk(trunk: string, inWorktree?: string): void {
  if (currentBranch() === trunk) {
    gitArgs(['merge', '--ff-only', `origin/${trunk}`]);
    return;
  }
  if (inWorktree) {
    // Keeps that worktree's HEAD, index and files consistent with the new ref.
    gitArgs(['-C', inWorktree, 'merge', '--ff-only', `origin/${trunk}`]);
    return;
  }
  gitArgs(['merge-base', '--is-ancestor', trunk, `origin/${trunk}`]);
  gitArgs(['branch', '-f', trunk, `origin/${trunk}`]);
}
```

**Do not** reach for `git update-ref refs/heads/main` as the shortcut here. It
succeeds (verified: `rc=0`) precisely because it skips the safety check — it moves
the ref out from under the other worktree without touching its HEAD, index, or
working files, so that worktree is left looking like it has a tree full of
uncommitted reversions. Silent corruption of someone else's checkout is worse than
the fatal.

`git -C <wt> merge --ff-only` can still fail if that worktree is dirty; surface that
as `trunk is checked out at <path> and has local changes — commit or stash there,
then re-run`.

### Also: `ly checkout` / `up` / `down` onto trunk now give wrong advice

[checkout.ts:34](../src/commands/checkout.ts#L34), [up.ts:48](../src/commands/up.ts#L48),
[up.ts:82](../src/commands/up.ts#L82) all guard the target. Correct — `git checkout main`
is genuinely fatal when `main` lives elsewhere (verified). But the message is:

> Switch away from or remove that worktree, then re-run.

For trunk in a bare layout that is the opposite of what the user wants; the trunk
worktree is permanent. Special-case it:

```ts
if (target === store.trunk) {
  const at = branchCheckedOutElsewhere(target);
  if (at) throw new LyError(`${target} is checked out at ${at} — cd there instead.`);
}
```

### Test gap that would have caught this

[worktree-integ.test.ts](../src/__tests__/worktree-integ.test.ts) covers `init`,
`create`, `log`, `restack --all` and `checkout` across worktrees — but never `sync`,
the only command that moves trunk. Add:

```ts
it('syncs from a feature worktree while trunk lives in another', () => {
  const repo = createBareClone();
  const main = repo.addWorktree('main', 'main');
  main.ly(['init', '--trunk', 'main'], 'y\n');
  main.ly(['create', 'feature-a', '-m', 'feat: a']);
  const feat = repo.addWorktree('wa', 'feature-a');
  const res = feat.ly(['sync']);            // fails today
  expect(res.status).toBe(0);
});
```

---

## 2. HIGH — the now-shared store has no atomic write and no locking

**Where:** [store.ts:30-56](../src/store.ts#L30-L56)

Moving to `--git-common-dir` is the right call, and it is what makes the feature work.
It also changes the concurrency model. Before this PR each worktree resolved
`<worktreeRoot>/.git/ly/meta.json`, where `<worktreeRoot>/.git` is a *file* — so
`mkdirSync` threw `ENOTDIR` and worktrees never shared state. Now they all read and
write one file, and the whole codebase does read-modify-write with no coordination:

```ts
const store = load();           // read
store.branches[x] = { parent }; // modify
save(store);                    // write — last writer wins
```

Two consequences:

- **Lost updates.** `ly create` in worktree A and `ly track` in worktree B
  interleaved: whichever calls `save()` second silently discards the other's branch.
  In a bare + worktree setup, running `ly` in two panes is the normal workflow, not an
  edge case. `sync` widens the window a lot — it holds `store` in memory across
  network calls to the GitHub API and interactive `multiselect` prompts, so the
  read-to-write gap can be minutes long.
- **Truncated JSON.** `writeFileSync` is not atomic. Ctrl-C or a crash mid-write
  leaves a partial file, and [store.ts:49](../src/store.ts#L49) is a bare
  `JSON.parse(...) as LyStore` — the user gets a raw `SyntaxError` stack trace and
  every `ly` command is bricked until they hand-delete the file.

### Fix

Write atomically, and read defensively:

```ts
import { renameSync } from 'node:fs';

export function save(store: LyStore): void {
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  // Same directory, so the rename is atomic; never leaves a partial meta.json.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function load(): LyStore {
  const path = getStorePath();
  if (!existsSync(path)) {
    throw new LyError(
      'Lythium is not initialized in this repo. Run `ly init` first.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LyError(
      `Stack metadata at ${path} is not valid JSON. ` +
        'Fix it by hand or re-run `ly sync --rebuild`.',
    );
  }
  if (!isLyStore(parsed)) {
    throw new LyError(
      `Stack metadata at ${path} is malformed (missing trunk/branches).`,
    );
  }
  return parsed;
}

function isLyStore(v: unknown): v is LyStore {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<LyStore>;
  return (
    typeof s.trunk === 'string' &&
    typeof s.branches === 'object' &&
    s.branches !== null
  );
}
```

The shape check is not academic. `guardBranchesAvailable(Object.keys(store.branches))`
is now the *first* thing `sync` does with the store, so a `branches`-less file turns
into `Cannot convert undefined or null to object` from inside the new guard —
a confusing place to land.

For lost updates, the cheap durable fix is an `O_EXCL` lockfile next to the store,
held for the read-modify-write span, with a stale-lock timeout:

```ts
export function withStoreLock<T>(fn: () => T): T {
  const lock = `${getStorePath()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lock, 'wx');            // fails if another ly holds it
  } catch {
    throw new LyError(
      'Another `ly` command is modifying this repo (possibly in another worktree). ' +
        `Wait for it to finish, or delete ${lock} if no ly is running.`,
    );
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
```

If a lock is more than this PR should take on, at minimum do the atomic write and the
parse guard here, and open a follow-up — but say so in `CLAUDE.md`, because the doc
change at `packages/cli/CLAUDE.md` now advertises "every linked worktree shares one
store" without noting that concurrent writes are unsafe.

**Migration:** none needed, and worth stating explicitly. For a normal repo
`--git-common-dir` *is* `<repoRoot>/.git`, so the path is unchanged; from a linked
worktree the old path could never have been written. No existing user loses data.

---

## 3. HIGH (pre-existing, reachable) — shell injection from PR bodies via `git()`

**Where:** [git.ts:21-32](../src/git.ts#L21-L32) and every `git()` caller that
interpolates a branch name

`git(cmd)` runs `execSync('git ' + cmd)` — through a shell. Branch names are
interpolated raw. Git's ref rules forbid spaces, `~^:?*[`, and control characters,
but **permit** `;`, `|`, `&`, `$`, `(`, `)`, `<`, `>`, `!` and `#` — everything you
need for command substitution.

Full chain, all in-tree:

```
GitHub PR body
  → parseStackLine()        sync.ts:65   backtick-delimited capture, no ref validation
  → branches{} keys         sync.ts:144
  → trackRemoteBranch(b)    sync.ts:172
  → git('branch --track ' + branch + ' origin/' + branch)   git.ts:262   ← shell
```

A PR body containing a stack section whose entry is a backtick-quoted `x;calc;#` gets
that string adopted as a branch name and pasted into a shell command by
`ly sync --rebuild`. `rebuildStore` reads open PRs on the repo, so anyone able to open
a PR — including via fork, depending on the listing query — can execute code on a
maintainer's machine. The `catch` at [sync.ts:174](../src/commands/sync.ts#L174) just
prints `not on remote, skipping`: the payload has already run.

The same interpolation reaches `commitHash`, `createBranch`, `checkout`, `rebase`,
`isMergedInto`, `deleteBranch`, and `push`.

### Fix

Two independent layers; do both.

**a. Convert the ref-taking helpers to `gitArgs`.** Mechanical, no behavior change:

```ts
export function checkout(branch: string): void     { gitArgs(['checkout', branch]); }
export function createBranch(n: string, b: string) { gitArgs(['checkout', '-b', n, b]); }
export function commitHash(branch: string): string { return gitArgs(['rev-parse', branch]); }
export function rebase(onto: string): void         { gitArgs(['rebase', onto]); }
export function deleteBranch(b: string, f = false) { gitArgs(['branch', f ? '-D' : '-d', b]); }
export function trackRemoteBranch(b: string): void { gitArgs(['branch', '--track', b, `origin/${b}`]); }
export function push(branch: string, force = false): void {
  gitArgs(['push', 'origin', branch, ...(force ? ['--force-with-lease'] : [])]);
}
export function commit(message: string): void      { gitArgs(['commit', '-m', message]); }
```

The `commit`/`amendCommit` `JSON.stringify(message)` trick is worth killing too —
it produces double quotes, which `cmd.exe` and PowerShell parse differently from
`sh`, so multi-line and `%VAR%`-containing messages already behave inconsistently
across platforms. `gitArgs` removes the whole class.

Once these are converted, `git(cmd)` should only ever see constant strings; consider
renaming it `gitConst`, so the next contributor does not reintroduce the pattern.

**b. Validate refs at the trust boundary.** Anything parsed out of a PR body should
be checked before it is used at all:

```ts
/** Reject anything git itself would reject as a branch name. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  try {
    gitArgs(['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}
```

and in `parseStackLine`, drop entries that fail it. Defence in depth: even with
`gitArgs`, an adopted branch name like `--upload-pack=…` or `-D` is an
argument-injection risk in commands where it is not positioned after `--`.

---

## 4. MEDIUM — `samePath()` compares path *text*, not filesystem identity

**Where:** [worktree.ts:11-14](../src/worktree.ts#L11-L14)

```ts
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}
```

The docstring claims "case/separator tolerant". Only on Windows. `node:path`'s
`relative` picks its comparison rules from the *host* platform, not the filesystem:

| a | b | `relative(a,b)===''` |
|---|---|---|
| `C:/a/b` | `C:/a/b` | ✅ |
| `C:/a/b` | `c:/A/B` | ✅ (win32 only) |
| `C:/a/b` | `C:/a/b/` | ✅ |
| `/tmp/x` | `/private/tmp/x` | ❌ |

The failure direction is the bad one. If the two spellings disagree, `samePath`
returns false, `branchCheckedOutElsewhere` reports the *current* worktree as a
conflict, and `guardBranchesAvailable` hard-blocks the user from operating on the
branch they are standing on — with a message telling them to remove a worktree they
are inside. Two realistic triggers:

- **Symlinked paths.** `git worktree list` reports the path as recorded at
  `worktree add` time; `rev-parse --show-toplevel` resolves symlinks. Create a
  worktree under a symlinked parent (`/tmp` → `/private/tmp` on macOS, or any
  convenience symlink into a projects dir) and the two disagree.
- **Case-insensitive non-Windows filesystems.** APFS is case-insensitive by default;
  `relative` on darwin is case-*sensitive*. `~/Projects/repo` vs `~/projects/repo`
  compares unequal.

### Fix

Compare identity, and always leave an escape hatch:

```ts
import { realpathSync, statSync } from 'node:fs';

/** Same directory on disk? Compares device+inode, falling back to resolved paths. */
function samePath(a: string, b: string): boolean {
  try {
    const [sa, sb] = [statSync(a), statSync(b)];
    if (sa.ino !== 0 && sb.ino !== 0) return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    /* one of them is gone — fall through to text comparison */
  }
  try {
    return relative(realpathSync.native(a), realpathSync.native(b)) === '';
  } catch {
    return relative(a, b) === '';
  }
}
```

`realpathSync.native` is the important half: it normalizes both symlinks and case on
Windows and macOS. (`ino` is `0` on some Windows filesystems, hence the guard.)

Add `--no-worktree-check` to the guarded commands regardless. Any heuristic that can
produce a false positive needs a bypass; without one, a user hitting this has no way
to use the tool at all short of editing the source.

---

## 5. MEDIUM — `branchCheckedOutElsewhere` silently disables itself in a bare dir

**Where:** [worktree.ts:38-44](../src/worktree.ts#L38-L44)

```ts
try {
  here = getRepoRoot();
} catch {
  // No working tree (running from the bare dir) — nothing local to conflict.
  return undefined;
}
```

The comment's conclusion does not follow from its premise. Having no working tree does
not mean there is no conflict — it means *everything* conflicts. Running `ly restack`
from the bare directory hits `fatal: this operation must be run in a work tree`
(verified) no matter which branch is involved. Returning `undefined` turns off the
guard exactly where the friendly error is most valuable, and the user gets a raw git
message instead.

`ly init` and `ly log` *do* work from the bare dir now (the store resolves, and
`listLocalBranches` needs no worktree), so users will end up running commands there.

### Fix

Treat "no working tree" as "not here", so every hit is reported:

```ts
let here: string | undefined;
try {
  here = getRepoRoot();
} catch {
  // No working tree: nothing can be checked out *here*, so every hit is elsewhere.
  return hit.path;
}
return samePath(hit.path, here) ? undefined : hit.path;
```

Better still, have the branch-mutating commands reject the bare dir up front with
`This command needs a working tree — cd into one of your worktrees` rather than
letting each guard rediscover it.

---

## 6. LOW — `getRepoRoot()` spawns one `git` per branch

**Where:** [worktree.ts:54-61](../src/worktree.ts#L54-L61)

`listWorktrees()` is correctly hoisted out of the loop; `getRepoRoot()` is not — it is
called inside `branchCheckedOutElsewhere` on every iteration. `ly sync` guards every
tracked branch, so a 20-branch stack spawns 20 redundant
`git rev-parse --show-toplevel` processes. Process spawn on Windows is ~20–40 ms, so
this is a visible half-second stall on the hot path.

```ts
export function assertBranchesAvailable(branches: Iterable<string>): void {
  const worktrees = listWorktrees();
  let here: string | undefined;
  try {
    here = getRepoRoot();
  } catch {
    /* bare dir; see §5 */
  }

  const conflicts: string[] = [];
  for (const branch of new Set(branches)) {
    const hit = worktreeForBranch(branch, worktrees);
    if (hit && !(here && samePath(hit.path, here))) {
      conflicts.push(`  ${branch} — checked out at ${hit.path}`);
    }
  }
  // …
}
```

That means exporting `samePath` or taking `here` as an optional parameter on
`branchCheckedOutElsewhere` — either is fine; the second keeps the single-branch
helper usable and testable.

---

## 7. LOW — `guardBranchesAvailable` calls `process.exit` from a library module

**Where:** [worktree.ts:76-83](../src/worktree.ts#L76-L83)

```ts
console.error(pc.red(...));
process.exit(1);
```

Two problems. `process.exit` from a shared helper makes the function untestable
without subprocess plumbing (which is why the guard is only covered through the
integration tests, and why the trunk gap in §1 slipped through). And on Windows,
`process.exit` immediately after `console.error` can truncate the message when stderr
is a pipe — a CI log or `ly … 2>&1 | tee` loses the very explanation the guard exists
to print.

`modify.ts` already shows the better pattern: it calls `assertBranchesAvailable` and
lets its own `catch` render the `LyError`
([modify.ts:76-79](../src/commands/modify.ts#L76-L79)). Prefer that everywhere and
drop `guardBranchesAvailable`; the five call sites that use it are all inside command
actions that either have, or trivially can have, a `try/catch`. That also removes the
current inconsistency where the same condition throws in one command and exits in
five.

---

## 8. LOW — `bareWithMultipleWorktrees` is dead, and `describeWorktreeLayout` can crash `ly init`

**Where:** [worktree.ts:85-108](../src/worktree.ts#L85-L108), [init.ts:66](../src/commands/init.ts#L66)

- `WorktreeLayout.bareWithMultipleWorktrees` is computed and exported but read
  nowhere; `init.ts` branches on `worktreeCount > 1` and `bare` directly. Either use
  it or delete it — a public field that nothing consumes will drift.
- `describeWorktreeLayout()` spawns two git processes (`listWorktrees` +
  `isBareRepo`) where one would do. `isBareRepo()` is genuinely needed (from a linked
  worktree, `--is-bare-repository` is `false` while the bare entry does appear in the
  list) — but the list alone already answers it, so the extra call only matters if you
  want to detect a bare dir with zero worktrees. Worth a comment either way.
- `init.ts`'s action has **no `try/catch`**, and `describeWorktreeLayout()` runs
  *after* `init(trunk)` has written the store (line 64). If `listWorktrees()` throws,
  the user sees an unhandled-rejection stack trace and reasonably concludes `ly init`
  failed — but the repo is initialized, so re-running gives
  `Lythium is already initialized`. Move the layout note before `init(trunk)`, or wrap
  it in `try {} catch {}` since it is purely informational.

---

## 9. LOW — git version floor is undeclared

**Where:** [git.ts:80](../src/git.ts#L80), [git.ts:95](../src/git.ts#L95)

- `rev-parse --path-format=absolute` requires **git ≥ 2.31** (Mar 2021)
- `worktree list --porcelain -z` requires **git ≥ 2.36** (Apr 2022)

On anything older, `getStorePath()` throws `unknown option`. `isInitialized()`
swallows it ([store.ts:34-40](../src/store.ts#L34-L40)) and returns `false`, so the
user is told `Lythium is not initialized in this repo. Run ly init first.` — and
`ly init` then fails the same way. Unbounded confusion for a one-line check.

Document the floor and add a real preflight check, or make `gitCommonDir()` fall back:

```ts
export function gitCommonDir(): string {
  try {
    return git('rev-parse --path-format=absolute --git-common-dir');
  } catch {
    // git < 2.31: --git-common-dir may be relative to cwd.
    return resolve(git('rev-parse --git-common-dir'));
  }
}
```

Note the trailing-NUL detail while you are in `listWorktrees`: `gitArgs` ends with
`.trim()`, and JS `trim()` does **not** strip `\0` (it is not whitespace), so
`out.split('\0')` yields a trailing empty element. Harmless today — the empty string
matches none of the branches and `flush()` handles it — but it is load-bearing on the
`else if (!current)` fallthrough, so it deserves a comment rather than being
rediscovered by whoever next edits the parser.

---

## 10. LOW — test helper issues

**Where:** [helpers/repo.ts](../src/__tests__/helpers/repo.ts)

- **Store path is hardcoded.** `createTempRepo()` writes `<dir>/.git/ly/meta.json`
  (line 72). That duplicates the logic `getStorePath()` owns and only coincides with
  it for non-bare repos. If the store location ever moves again, these tests pass
  against a file production no longer reads. Derive it from
  `git rev-parse --path-format=absolute --git-common-dir`, or just run `ly init`.
- **No cleanup.** Nothing in `src/__tests__/` calls `rmSync` on these directories.
  `createBareClone()` builds an upstream repo, a bare clone, and N worktrees per
  test — every run leaks the lot into `tmpdir()`. Add an `afterEach` (or return a
  `cleanup()` from the factory) with `rmSync(root, { recursive: true, force: true })`.
- **Predictable temp names.** `uniqueDir()` uses `Date.now()` + `Math.random()`
  (line 60). In a world-writable `/tmp` on shared CI that is a pre-creation /
  symlink-swap target. `mkdtempSync(join(tmpdir(), 'ly-integ-'))` is the same length
  and does it correctly. Same pattern in
  [store.test.ts:18-22](../src/__tests__/store.test.ts#L18-L22).
- **`env` replaces instead of merges.** `env: env ?? { ...process.env, NO_COLOR: '1' }`
  (lines 48, 153): a caller passing `{ FOO: 'bar' }` gets a child with no `PATH`, so
  `spawnSync('node', …)` fails on Windows with a confusing `ENOENT`. Should be
  `env: { ...process.env, NO_COLOR: '1', ...env }`.

---

## Suggested order of work

**Before merge**

1. §1 — guard trunk, add `updateTrunk(trunk, inWorktree)`, add the `sync` integration test
2. §2 — atomic `save()`, defensive `load()` (lock can be a follow-up if documented)
3. §5 — invert the bare-dir early return

**Before the next release**

4. §3 — convert ref helpers to `gitArgs`, validate PR-body-derived names
   (worth its own PR and its own changeset entry; it is a security fix, not part of
   LYT-41)
5. §4 — identity-based `samePath` + `--no-worktree-check`

**Cleanup, any time**

6. §6 hoist `getRepoRoot`, §7 drop `process.exit` from the helper, §8 dead field +
   `init` crash window, §9 version floor, §10 test helpers
