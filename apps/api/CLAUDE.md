# CLAUDE.md — api

Guidance for Claude Code when working in `apps/api`. See the repo-root `CLAUDE.md` for monorepo-wide conventions.

# What this is

`@lythium/api` — a small Deno + Hono HTTP service that reconstructs a stacked-PR chain from GitHub and returns the combined diff for the web app to render.

**Runtime is Deno, not Node.** No build step, no `node_modules`, no `dist/`. Dependencies resolve from `deno.lock` and npm specifiers in `main.ts`. `.vscode/settings.json` scopes the Deno language server to this directory only — keep Deno-specific code inside `apps/api`.

# Commands

```
pnpm --filter @lythium/api dev     # deno run --watch -N main.ts
```

`-N` grants network access (GitHub API + the HTTP listener). The server only starts when `main.ts` is the entry module (`Deno.mainModule === import.meta.url`); importing it (e.g. from tests or an RPC client) does not bind a port.

Run `pnpm biome ci` from the repo root for lint/format. There is no test suite here yet.

# Architecture

Single endpoint:

```
GET /repos/:owner/:repo/pr/:pr_number/diff
```

- **Auth**: the caller's GitHub token is passed through as `Authorization: Bearer <token>`. The service has **no** credentials of its own — every GitHub call uses the caller's token. Missing/malformed header → 401.
- **Stack reconstruction**: starting from the requested PR, walk *up* the stack by treating each PR's `base.ref` as the head of its parent PR and searching open PRs for it. Stops when no parent PR is found or at `MAX_STACK_DEPTH` (20). The `prs` array is kept bottom-to-top (`unshift` parents).
- **Per-PR diff**: for each PR, `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}`; a failed compare yields an empty diff entry rather than failing the whole response.
- **Response**: `StackDiffResponse` (`{ stack: StackItem[] }`), bottom-to-top.
- GitHub error mapping: upstream 401 → 401, 404 → 404, 403/429 → 429 (with `Retry-After`), anything else → 502.
- CORS is wide open (`hono/cors` on `*`).

`export type AppType = typeof app` is exported for a potential Hono RPC client.

# Types contract

`types.ts` (`GitHubRef`, `DiffFile`, `StackPR`, `StackDiff`, `StackItem`, `StackDiffResponse`) is imported by the web app as `@lythium/api/types` (see `package.json` `exports`). Any change to these shapes is a breaking change for `apps/web` — update both sides together.
