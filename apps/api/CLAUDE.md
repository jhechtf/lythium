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

# Guided review (review-groups.ts; needs DATABASE_URL, else 503)
GET    /repos/:source/:owner/:repo/pr/:pr_number/groups            # groups + unassigned files
POST   /repos/:source/:owner/:repo/pr/:pr_number/groups            # create (author / push access)
PUT    /repos/:source/:owner/:repo/pr/:pr_number/groups            # replace all (e.g. accept AI groups)
PATCH  /repos/:source/:owner/:repo/pr/:pr_number/groups/:group_id  # rename, move, set/add/remove files
DELETE /repos/:source/:owner/:repo/pr/:pr_number/groups/:group_id
PUT    /repos/:source/:owner/:repo/pr/:pr_number/groups/:group_id/reviewed  # review-progress.ts
PUT    /repos/:source/:owner/:repo/pr/:pr_number/files/viewed
GET    /repos/:source/:owner/:repo/pr/:pr_number/progress
```

- **Checks**: check runs plus legacy commit statuses for the PR's head sha. Each check is normalized to `passed` (success, neutral), `failed`, `running` (anything not completed, or a pending status) or `skipped` (skipped, stale). Overall state is `failed` > `running` > `passed`, or `none` with no checks. Each list is capped at 1000 (`MAX_PAGES` × 100); when GitHub has more, the response sets `truncated: true` and a result that would be `passed` is `unknown` instead, because an unfetched check could be failing. Durations come from check-run start/finish and are null while running; commit statuses have no start time, so their duration is always null. The commit-status lookup is best-effort (tokens often lack the permission); a failing check-runs call fails the request. Both lists use `githubFetchAllCounted`: page 1 first, then the remaining pages (from `total_count`) in parallel, since the web app polls this while CI runs. The failing-conclusion set is shared with `pr-details.ts` (`FAILING_CONCLUSIONS`) so both endpoints classify a check the same way.

- **`:source`** is the hosting platform. Only `github` is implemented; any other value → 400 `{ error, supported }`. GitLab (and maybe Forgejo) are planned, so keep platform-specific calls behind the `github.ts` boundary.

- **Params**: every route goes through `repoParams(c)`. `owner`/`repo` must be GitHub names (`[A-Za-z0-9._-]`, not `.`/`..`) and are URL-encoded; `pr_number` must be a positive integer. Anything else → 400 before any GitHub call. Hono decodes params, so without this `..%2F` would let a request reach any GitHub endpoint with the caller's token.
- **Auth**: the caller's GitHub token is passed through as `Authorization: Bearer <token>`. The service has **no** credentials of its own — every GitHub call uses the caller's token. Missing/malformed header → 401.
- **Stack reconstruction**: starting from the requested PR, walk *up* the stack by treating each PR's `base.ref` as the head of its parent PR and searching open PRs for it. Stops when no parent PR is found or at `MAX_STACK_DEPTH` (20). The `prs` array is kept bottom-to-top (`unshift` parents).
- **Per-PR diff**: for each PR, `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}`; a failed compare yields an empty diff entry rather than failing the whole response.
- **Response**: `StackDiffResponse` (`{ stack: StackItem[] }`), bottom-to-top.
- **GitHub calls** go through `github.ts`: `githubFetch` (caller's token, 10s timeout, never throws) and `upstreamError`. Error mapping: upstream 401 → 401, 404 → 404, 429 → 429 (with `Retry-After`), timeout → 504, anything else (including network errors) → 502. A 403 is a rate limit (→ 429) only when GitHub marks it as one (`x-ratelimit-remaining: 0` or `Retry-After`); otherwise it's a missing permission and stays 403, so polling clients don't retry forever.
- CORS is wide open (`hono/cors` on `*`).

`export type AppType = typeof app` is exported for a potential Hono RPC client.

# Guided-review state (LYT-60)

Guided review needs state GitHub doesn't hold: review groups, which groups a reviewer marked reviewed, and which files they viewed. Decisions:

- **Storage**: Postgres via `@lythium/db` (Drizzle), the same schema and database as the GitHub App's webhook tables. Tables: `review_groups`, `review_group_files` (path + optional new-file line range), `review_group_reviews`, `review_viewed_files`. Data access lives in `packages/db/src/review-state.ts`; tests run the real migrations on PGlite (in-process Postgres, no Docker).
- **One copy of drizzle-orm**: apps import query operators (`and`, `eq`, …) from `@lythium/db`, never from `drizzle-orm` directly. A second copy (pnpm makes one per peer set, e.g. with PGlite) makes Drizzle's types incompatible.
- **Identity**: keyed by the GitHub numeric user id from `GET /user` with the caller's token (`fetchViewer` in `review-context.ts`). Logins can be renamed, so they aren't keys. Tokens are never stored.
- **Sharing**: groups are shared on the PR (the author or AI clustering can set them up once for every reviewer). Reviewed and viewed marks are private per user.
- **New push**: everything is pinned to the PR head sha it was made at. Reads only return state for the current head sha, and every write first discards rows from older shas, so a push resets groups and progress and groups are rebuilt (manually or by LYT-63).
- **Head sha comes from GitHub, never the client**: writes delete every user's state for other shas, so a made-up or stale sha would wipe shared state. Every data-access function takes a branded `VerifiedPR` (owner, repo, number, head sha); the only intended way to get one is `resolvePR(token, owner, repo, n)` in `review-context.ts`, which reads the PR from GitHub with the caller's token. That call is also the **access check** for reads and the caller's own reviewed/viewed marks: a caller who can't read the repo gets GitHub's 404/403 and never reaches the database. A group id from another PR or an older sha is "not found".
- **Changing shared groups needs more than read access**: on a public repo anyone can read a PR. Group writes (`createGroup`, `updateGroup`, `reorderGroups`, `deleteGroup`, `replaceGroups`) take an `EditablePR`; `editableBy(resolved, viewer)` grants one only to the PR's author or a caller with push/maintain/admin access. Both come from the same pulls response `resolvePR` already fetches (`user.id`, `base.repo.permissions`), so it costs no extra call. Otherwise answer 403.
- **Stale head observations**: the lock orders writes but not reads from GitHub, so a request that read the PR before a push can reach the lock after a newer request has written. `VerifiedPR` carries `observedAt` (stamped in `resolvePR` when GitHub answers), and `review_pr_heads` keeps the newest head seen per PR. Under the lock, a write at a different sha than a newer observation throws `StaleHeadError` (routes answer **409**; the client retries) instead of deleting the newer state. A newer observation moves the head and discards the older sha's state, which also handles a force-push back to an earlier sha. The common write (same sha as recorded) takes only the lock and one select, plus an in-place update when its observation is newer; it skips the discard deletes, since nothing older can exist. `discardStaleState` is private to `beginWrite` for this reason. Ordering uses the API server's clock, so two API instances with skewed clocks can misorder writes made within the skew.
- **Write serialization**: every write transaction first takes a per-PR advisory lock (`pg_advisory_xact_lock`), so concurrent writes can't race past the group cap or interleave a create with a reorder.
- **Input caps** (`REVIEW_LIMITS` in `review-state.ts`): 3000 files per group, 10k file entries per `replaceGroups`, 200 groups per PR, 3000 viewed files per user per PR, path 1024 bytes (the viewed-files primary key indexes the whole path, and Postgres limits an index entry to about 2.7 kB), name 200, description 10k. Violations throw `ReviewStateError` → 400. Every write, `deleteGroup` included, runs in a transaction that starts with `beginWrite` (lock the PR, drop older-sha state).
- **Consistent reads**: `listGroups`, `getGroup` and `getProgress` read a group and its files in one repeatable-read snapshot. Writes return what they wrote by reading inside their own locked transaction, never after commit.
- **Owner/repo names**: `isGithubName` in `github.ts` is the one validator for owner and repo path segments; routes and `resolvePR` share it.
- **Owner/repo casing**: GitHub names are case-insensitive, so `verifiedPR` lowercases `owner` and `repo`. Every spelling of a PR's URL then shares one set of groups, marks and one write lock.
- **GitHub lookups**: `resolvePR` and `fetchViewer` use `githubFetch` with a 5s timeout (→ 504; network error → 502); a failure is a `FetchResult` to pass to `upstreamError`. `fetchViewer` caches the viewer for 60s, keyed by the SHA-256 of the token (never the raw token), max 1000 entries. Routes should run both lookups with `Promise.all`.
- **No database required**: the API starts and serves the GitHub-backed routes without `DATABASE_URL`. The connection opens on first use (`getReviewDb`); guided-review routes use the `requireReviewDb` middleware, which answers 503 when it isn't set.

# Review groups (LYT-61)

- **Routes** live in `review-groups.ts`, mounted with `app.route` under the PR prefix. Each applies `requireReviewDb` itself (not `use('*')`, which would also match the GitHub-only routes). `guidedRequest(c, { files })` is the shared preamble: source, token, params, then `resolvePR`, `fetchViewer` and (when asked) `fetchPRFiles` in parallel. `stateError` maps `ReviewStateError` → 400 and `StaleHeadError` → 409. `route-params.ts` holds `repoParams`, `unsupportedSource` and `bearerToken` for every route. Write routes (`POST`/`PUT`/`PATCH`) run `checkRequest` (source, token, params) and `bodyLimit` (4 MB `POST`, 12 MB `PUT`/`PATCH`, → 413) before reading the body, so an unauthenticated caller can't make the API buffer and parse a large body.
- **PR files** (`pr-files.ts`): `fetchPRFiles` pages `GET /pulls/{n}/files` (100 per page, up to GitHub's 3000-file cap). Most PRs are one call. When page 1 is full, the remaining pages come from the PR's `changed_files` (on `ResolvedPR`, from the `resolvePR` call running alongside) and are fetched in parallel; without a count it pages serially. `patch` is kept: AI clustering uses it for excerpts. Only routes that need the list fetch it: `GET` and `PUT /groups`, `POST` with files, `PATCH` with `files`/`addFiles`. Deleting a group or renaming it doesn't.
- **Validation against the PR**: every added path must be a file the PR changes, and a line range can't be on a file the PR deletes (ranges refer to the new file). Removing an entry needn't match the PR, so a stale entry can be cleaned up. Range shape (both ends, start ≤ end, ≥ 1) is the data layer's check. Ranges aren't checked against the new file's length: that would need the file contents.
- **Unassigned**: changed files that no group mentions. A file with only a line range in a group counts as assigned.
- **PATCH**: `files` replaces the list; `addFiles`/`removeFiles` edit it in place inside the locked transaction (so two people adding files don't overwrite each other) and can't be combined with `files`. `removeFiles` matches path and range exactly; no range means the whole-file entry. `position` moves the group (past the end → last) in the same transaction.
- **PUT**: `source: 'ai'` stores `createdBy: null` (AI groups have no human author, even when a person accepts them); `manual` stores the caller.
- **Tests** use `@lythium/db/testing` (`createTestDb`, `resetReviewState`): PGlite with the real migrations, from the db package so there's one copy of drizzle-orm. `review-test-utils.ts` fakes the GitHub lookups.

# Review progress (LYT-62)

- **Routes** in `review-progress.ts`, built on `guidedRequest`/`stateError` from `review-groups.ts`. Marks are private to the caller and need only read access to the PR (no `editableBy`).
- `PUT …/groups/:id/reviewed` `{ reviewed }` and `PUT …/files/viewed` `{ paths, viewed }` answer 204. The viewed route marks a batch in one transaction (`setFilesViewed`) and does **not** fetch the PR's files: ticking files is the hottest write, a stray path is harmless, and the per-user cap bounds it.
- `GET …/progress` fetches the PR's files for the total and counts only viewed paths still in the PR, so the numbers match "3 of 7 groups reviewed" / "4 of 12 viewed".
- **After a push**, progress resets (state is pinned to the head sha, see LYT-60): a file changed since it was viewed has to be viewed again. Files that didn't change are reset too; keeping them would need per-file blob shas.
- Progress is keyed by GitHub user id, so it survives reloads and other browsers or tokens for the same user.

Migrations: `pnpm --filter @lythium/db generate` after a schema change, `DB_URL=… pnpm --filter @lythium/db migrate` to apply.

# Types contract

`types.ts` (`GitHubRef`, `DiffFile`, `StackPR`, `StackDiff`, `StackItem`, `StackDiffResponse`, and the guided-review request/response types such as `ReviewGroup`, `ReviewGroupsResponse` and `ReviewProgressResponse`) is imported by the web app as `@lythium/api/types` (see `package.json` `exports`). Any change to these shapes is a breaking change for `apps/web` — update both sides together.
