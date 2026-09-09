# CLAUDE.md — `ly` CLI

Guidance for Claude Code when working in `packages/cli`. See the repo-root `CLAUDE.md` for monorepo-wide conventions.

# What this is

`@lythium/cli` — the `ly` command: an open-source, git-compatible stacked-diff workflow. Node 20, TypeScript, built with tsdown to `dist/index.mjs` (the `ly` bin).

# Commands

```
pnpm --filter @lythium/cli build     # rebuild after changing CLI source (tsdown → dist/index.mjs)
cd packages/cli && pnpm link         # (re)link `ly` globally if the command is missing
```

`ly` is linked globally via `pnpm link`. Changes to `src/` do **not** take effect until you rebuild. Run `pnpm biome ci` from the repo root when done.

`ly --debug <cmd>` prints every underlying git command to stderr — use it when diagnosing stack/rebase behavior.

# Architecture

Built with Commander. Each subcommand is a module under `src/commands/` that calls `program.command(...)` as an import side effect; `src/index.ts` wires them up by importing each one and then calling `program.parse`.

- **`src/store.ts`** — persistent state at `<repoRoot>/.git/ly/meta.json`:
  `{ trunk, branches: { [name]: { parent, prNumber?, prUrl? } } }`.
  A pure parent-pointer graph — no ordering is stored. `load()` throws `LyError` if the repo isn't initialized; commands catch it and exit non-zero.
- **`src/stack.ts`** — derives structure from the store: `getAncestors` / `getStack` / `getAllDescendants` (BFS, parent always before child), tree rendering for `ly log`, and the PR-body **stack section**: a markdown block fenced by the HTML comments `STACK_START` / `STACK_END`. `ly sync --rebuild` parses that same section back out of open PRs to reconstruct the store, so the format here is a serialization contract, not just display — change both the writer (`buildStackSection`) and the reader (`parseStackSection` in `commands/sync.ts`) together.
- **`src/git.ts`** — all git goes through here. `git(cmd)` uses `execSync` (shell); `gitArgs(args)` uses `execFileSync` (argv, no shell) — use `gitArgs` for any value that is not a trusted, validated ref. Errors are wrapped as `GitError` from stderr. `forceRebase(branch, onto, returnTo)` is the workhorse for restacking and always attempts to return to `returnTo`, even on rebase failure.
- **Auth** — `src/auth.ts` + `src/credentials.ts`. `ly auth login` takes a GitHub PAT (scopes `repo`, `read:user`), validates it against `GET /user`, and stores it with `conf` under project name `lythium`. All GitHub calls use `undici` `fetch` with a `lythium-cli` User-Agent.

# Command behaviors

- `ly init` — records `trunk` (auto-detects `main`/`master`, else prompts), creates the store. Refuses if already initialized or not a git repo.
- `ly log` — the **default** command (bare `ly`); renders the stack tree. `-s/--short` shows only the current lineage.
- `ly create [branch]` — new branch stacked on current HEAD; commits staged changes, or makes an empty commit if nothing is staged; records `parent`.
- `ly track [branch]` — start tracking an existing branch; prompts for its parent.
- `ly untrack [branch]` — drop a branch from the store (warns about orphaned children; does not touch git).
- `ly checkout [branch]` (alias `ly co`) — switch to a tracked branch; interactive picker when no arg.
- `ly up` / `ly down` — move to a child (prompts if several) / to the parent branch.
- `ly modify` — amends the current branch, then restacks all descendants automatically (`forceRebase` each, then return to the branch).
- `ly restack` — rebases descendants onto their recorded parents to repair alignment. `--all` does every tracked branch.
- `ly submit` — two phases: (1) push each target branch and create/update its PR so all PR numbers are known, saving the store after each; (2) rewrite every target PR body's stack section so they cross-link. `--stack` submits the whole stack; `--draft`, `--title`, `--body` as expected.
- `ly sync` — fetch; fast-forward local trunk (**aborts** if trunk can't fast-forward — a stale trunk would corrupt the restack); detect branches merged into `origin/<trunk>`; prompt to delete them, reparenting their children to the deleted branch's parent; restack everything else. `--rebuild` first reconstructs the store from open PRs' stack sections (use when moving to a new machine).

# Testing

There is no test suite in this package yet. Verify changes by building and exercising `ly` against a scratch repo.
