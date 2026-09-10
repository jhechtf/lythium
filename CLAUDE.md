# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Overview

Lythium ("Stacks, Opened Up") is an open-source, git-compatible stacked-diff workflow, in the spirit of Graphite. It has three parts that share one data model — a chain of branches where each branch's parent is another branch or trunk:

- `packages/cli` — the `ly` CLI, the tool developers use to build and submit stacks
- `apps/api` — a Deno/Hono service that reconstructs a PR stack from GitHub and returns its combined diff
- `apps/web` — a SvelteKit app that renders that stacked diff for review

The CLI and the web/API side are largely independent: the CLI never talks to the API, and the API rebuilds stack structure from GitHub rather than from the CLI's local store.

Each package has its own `CLAUDE.md` with architecture and commands specific to it — read that when working inside a package:

- `packages/cli/CLAUDE.md`
- `apps/web/CLAUDE.md`
- `apps/api/CLAUDE.md`

# Monorepo

pnpm + Turborepo. Workspaces: `apps/*`, `packages/*`. Package manager is pinned in the root `package.json` (`packageManager` field) — use that pnpm version.

Run all services together (Turborepo TUI):

```
pnpm dev
```

Single app:

```
pnpm --filter web dev
pnpm --filter @lythium/api dev
```

# Checking work

After any change, run `pnpm biome ci` from the repo root and fix everything it reports. Biome config lives in the root `biome.json` (2-space indent, single quotes, recommended lint rules, import organization on). `apps/web` has its own `biome.json` extending the same defaults. Each package's `CLAUDE.md` lists its additional type-check and test commands.

Type-checking: `pnpm typecheck` (Turborepo, runs `tsc --noEmit` per package). The Node packages (`apps/api`, `apps/github-app`, `packages/cli`, `packages/db`) are on **TypeScript 7** (the native compiler — the `tsc` bin is the Go binary, no JS API). `apps/web` stays on TypeScript 5 because `svelte-check` needs the TS JS API. `pnpm bench:typecheck` compares TS 5 vs TS 7 type-check times — see `scripts/bench-typecheck.results.md`.

# Conventions

- **Branch names**: `[type]/[ticket#]-[description]`, `type` = conventional-commit type. e.g. `feat/lyt-6-web-ui-design`, `fix/lyt-3-cli-output-formatting`.
- **Commits**: conventional commits (`type(scope): description`). Commit with `--no-gpg-sign` (signing is handled externally).
- **Issues**: tracked in the **Lythium** team on Linear.
- **Multiple agents / stacked work**: build changes as stacked branches with the `ly` CLI where possible. Keep each change as small as it can be for review.
