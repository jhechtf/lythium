# CLAUDE.md — api

Guidance for Claude Code when working in `apps/api`. See the repo-root `CLAUDE.md` for monorepo-wide conventions.

# What this is

`@lythium/api` — a small Node + Hono HTTP service that reconstructs a stacked-PR chain from GitHub and returns the combined diff for the web app to render.

**Runtime is Node** (it was Deno until #18). Served with `@hono/node-server`; `tsx` for dev, `tsdown` for the build, Vitest for tests. The Hono `app` lives in `app.ts` (importable from tests without binding a port) and `main.ts` only starts the server (port from `PORT`, default 3000).

# Commands

```
pnpm --filter @lythium/api dev     # tsx watch main.ts
pnpm --filter @lythium/api build   # tsdown main.ts
```

Run `pnpm biome ci` from the repo root for lint/format. Tests: `pnpm --filter @lythium/api test` (Vitest; GitHub is stubbed via `fetch`).

# Architecture

Endpoints:

```
GET /repos/:source/:owner/:repo/pr/:pr_number/diff
GET /repos/:source/:owner/:repo/pr/:pr_number        # PR details + merge status (pr-details.ts)
```

- **`:source`** is the hosting platform. Only `github` is implemented; any other value → 400 `{ error, supported }`. GitLab (and maybe Forgejo) are planned, so keep platform-specific calls behind the `githubFetch` boundary.

- **Auth**: the caller's GitHub token is passed through as `Authorization: Bearer <token>`. The service has **no** credentials of its own — every GitHub call uses the caller's token. Missing/malformed header → 401.
- **Stack reconstruction**: starting from the requested PR, walk *up* the stack by treating each PR's `base.ref` as the head of its parent PR and searching open PRs for it. Stops when no parent PR is found or at `MAX_STACK_DEPTH` (20). The `prs` array is kept bottom-to-top (`unshift` parents).
- **Per-PR diff**: for each PR, `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}`; a failed compare yields an empty diff entry rather than failing the whole response.
- **Response**: `StackDiffResponse` (`{ stack: StackItem[] }`), bottom-to-top.
- GitHub error mapping: upstream 401 → 401, 404 → 404, 403/429 → 429 (with `Retry-After`), anything else → 502.
- CORS is wide open (`hono/cors` on `*`).

`export type AppType = typeof app` is exported for a potential Hono RPC client.

# Guided-review state (LYT-60)

Guided review needs state GitHub doesn't hold: review groups, which groups a reviewer marked reviewed, and which files they viewed. Decisions:

- **Storage**: Postgres via `@lythium/db` (Drizzle), the same schema and database as the GitHub App's webhook tables. Tables: `review_groups`, `review_group_files` (path + optional new-file line range), `review_group_reviews`, `review_viewed_files`. Data access lives in `packages/db/src/review-state.ts`; tests run the real migrations on PGlite (in-process Postgres, no Docker).
- **One copy of drizzle-orm**: apps import query operators (`and`, `eq`, …) from `@lythium/db`, never from `drizzle-orm` directly. A second copy (pnpm makes one per peer set, e.g. with PGlite) makes Drizzle's types incompatible.
- **Identity**: keyed by the GitHub numeric user id from `GET /user` with the caller's token (`fetchViewer` in `review-context.ts`). Logins can be renamed, so they aren't keys. Tokens are never stored.
- **Sharing**: groups are shared on the PR (the author or AI clustering can set them up once for every reviewer). Reviewed and viewed marks are private per user.
- **New push**: everything is pinned to the PR head sha it was made at. Reads only return state for the current head sha, and every write first discards rows from older shas, so a push resets groups and progress and groups are rebuilt (manually or by LYT-63).
- **Head sha comes from GitHub, never the client**: writes delete every user's state for other shas, so a made-up or stale sha would wipe shared state. Every data-access function takes a branded `VerifiedPR` (owner, repo, number, head sha); the only intended way to get one is `resolvePR(token, owner, repo, n)` in `review-context.ts`, which reads the PR from GitHub with the caller's token. That call is also the **access check**: a caller who can't read the repo gets GitHub's 404/403 and never reaches the database. A group id from another PR or an older sha is "not found".
- **Input caps** (`REVIEW_LIMITS` in `review-state.ts`): 3000 files per group, 10k file entries per `replaceGroups`, 200 groups per PR, path 4096 chars, name 200, description 10k. Violations throw `ReviewStateError` → 400.
- **GitHub lookups**: `resolvePR` and `fetchViewer` time out after 5s (→ 504; network error → 502). `fetchViewer` caches the viewer for 60s, keyed by the SHA-256 of the token (never the raw token), max 1000 entries. Routes should run both lookups with `Promise.all`.
- **No database required**: the API starts and serves the GitHub-backed routes without `DATABASE_URL`. The connection opens on first use (`getReviewDb`); guided-review routes use the `requireReviewDb` middleware, which answers 503 when it isn't set.

Migrations: `pnpm --filter @lythium/db generate` after a schema change, `DB_URL=… pnpm --filter @lythium/db migrate` to apply.

# Types contract

`types.ts` (`GitHubRef`, `DiffFile`, `StackPR`, `StackDiff`, `StackItem`, `StackDiffResponse`) is imported by the web app as `@lythium/api/types` (see `package.json` `exports`). Any change to these shapes is a breaking change for `apps/web` — update both sides together.
