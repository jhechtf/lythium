# CLAUDE.md — web

Guidance for Claude Code when working in `apps/web`. See the repo-root `CLAUDE.md` for monorepo-wide conventions.

# What this is

The Lythium review UI: a SvelteKit app that renders a stacked PR diff for review. Svelte 5 (runes), Tailwind 4, `adapter-auto`.

Two experimental features are enabled and relied on:

- **Async components** — `compilerOptions.experimental.async` in `svelte.config.js`; `+page.server.ts` load functions return promises straight through to `{#await}` in markup.
- **SvelteKit remote functions** — `kit.experimental.remoteFunctions`.

Prefer the `svelte5-sveltekit-expert` agent for non-trivial Svelte/SvelteKit work.

# Commands

```
pnpm --filter web dev                       # vite dev
pnpm --filter web check                     # svelte-kit sync + svelte-check (run after changes)
pnpm --filter web build                     # vite build
pnpm --filter web storybook                 # Storybook on :6006
```

Also run `pnpm biome ci` from the repo root. `apps/web` has its own `biome.json` extending the root config.

# Auth flow

GitHub OAuth via `octokit`'s `OAuthApp` (`src/lib/server/octokit.ts`), configured from `$env/static/private`:
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`. The API base URL is `API_URL` (also private static).

The user's access token lives in a `token` cookie. `src/hooks.server.ts` reads it on **every** request and constructs a per-request `Octokit` on `event.locals.octokit` (typed in `src/app.d.ts`). Server load functions use either `locals.octokit` (for GitHub calls) or read the `token` cookie directly to call the Lythium API with a `Bearer` header.

# Routes

- `/pr/[owner]/[repo]/[number]` — the stacked-diff view. `+page.server.ts` calls `${API_URL}/repos/{owner}/{repo}/pr/{number}/diff`, mapping API 401/404/429/other to SvelteKit `error()`. `+page.svelte` renders a `FileTree`, a card + `DiffViewer` per PR in the stack, and a stack sidebar.
- Response types come from the API package: `import type { StackDiffResponse } from '@lythium/api/types'`.

Some route files (`/+page.server.ts`, `/auth/github/callback`) are still scaffolding — hard-coded repos, `console.info` debugging. Don't copy those as patterns.

# Components

`src/components/<name>/`:

- `<name>.svelte` — the component
- `<name>.stories.svelte` — Storybook story (`@storybook/addon-svelte-csf`)
- `<name>.svelte.ts` — rune-based logic / shared reactive state where the component needs it

Import components via the `$components` alias (e.g. `$components/toast/toastPortal.svelte`). `$lib` is the standard SvelteKit alias.

Shared reactive singletons follow a "module-level rune container" pattern — e.g. `command/command.svelte.ts` exports a `CommandRegistry` backed by `SvelteMap` + `$derived`; `toast/toastState.svelte.ts` exports a `SvelteSet` of toasts with a `registerToast` that returns a disposer. New global UI state should follow the same shape.

The root `+layout.svelte` mounts `<Command>` (command palette), `<ToastPortal>`, and `<Rail>` around the routed `children`.

Key deps: `lucide-svelte` (icons), `cva` (variant classes), `diff2html` + `highlight.js` (diff rendering), `arktype` (runtime validation), `runed` (Svelte utilities).

# Tests

Vitest, two projects defined in `vite.config.ts`:

| project | environment | matches | notes |
|---|---|---|---|
| **client** | browser (Playwright/Chromium) | `src/**/*.svelte.{test,spec}.{js,ts}` | excludes `src/lib/server/**`; setup `vitest-setup-client.ts` |
| **server** | node | other `src/**/*.{test,spec}.{js,ts}` | |

`expect.requireAssertions` is on — every test must assert at least once. Component tests use `vitest-browser-svelte` (`render` + `page.getByRole` + `expect.element(...)`).

```
pnpm --filter web test                                                # unit once + e2e
pnpm --filter web test:unit                                           # vitest watch
pnpm --filter web test:unit -- --run                                  # vitest once
pnpm --filter web test:unit -- --run src/routes/page.svelte.spec.ts   # single file
pnpm --filter web test:unit -- --run -t "should render h1"            # single test
pnpm --filter web test:e2e                                            # Playwright; builds + previews on :4173, specs in e2e/
```
