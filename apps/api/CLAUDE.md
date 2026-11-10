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
GET /repos/:source/:owner/:repo/pr/:pr_number/checks # CI state, counts and per-check detail (checks.ts)
```

- **Checks**: check runs plus legacy commit statuses for the PR's head sha. Each check is normalized to `passed` (success, neutral), `failed`, `running` (anything not completed, or a pending status) or `skipped` (skipped, stale). Overall state is `failed` > `running` > `passed`, or `none` with no checks. Durations come from check-run start/finish and are null while running; commit statuses have no start time, so their duration is always null. The commit-status lookup is best-effort (tokens often lack the permission); a failing check-runs call fails the request.

- **`:source`** is the hosting platform. Only `github` is implemented; any other value → 400 `{ error, supported }`. GitLab (and maybe Forgejo) are planned, so keep platform-specific calls behind the `githubFetch` boundary.

- **Auth**: the caller's GitHub token is passed through as `Authorization: Bearer <token>`. The service has **no** credentials of its own — every GitHub call uses the caller's token. Missing/malformed header → 401.
- **Stack reconstruction**: starting from the requested PR, walk *up* the stack by treating each PR's `base.ref` as the head of its parent PR and searching open PRs for it. Stops when no parent PR is found or at `MAX_STACK_DEPTH` (20). The `prs` array is kept bottom-to-top (`unshift` parents).
- **Per-PR diff**: for each PR, `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}`; a failed compare yields an empty diff entry rather than failing the whole response.
- **Response**: `StackDiffResponse` (`{ stack: StackItem[] }`), bottom-to-top.
- GitHub error mapping: upstream 401 → 401, 404 → 404, 403/429 → 429 (with `Retry-After`), anything else → 502.
- CORS is wide open (`hono/cors` on `*`).

`export type AppType = typeof app` is exported for a potential Hono RPC client.

# Types contract

`types.ts` (`GitHubRef`, `DiffFile`, `StackPR`, `StackDiff`, `StackItem`, `StackDiffResponse`) is imported by the web app as `@lythium/api/types` (see `package.json` `exports`). Any change to these shapes is a breaking change for `apps/web` — update both sides together.
