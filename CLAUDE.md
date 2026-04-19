# Monorepo Structure

This is a pnpm + Turborepo monorepo with three packages:

- `apps/web` — SvelteKit frontend (Svelte 5, Tailwind 4, Vitest, Playwright)
- `apps/api` — Deno/Hono REST API
- `packages/cli` — the `ly` CLI (Node 20, built with tsdown to `dist/index.mjs`)

# Dev Server

Run all services together:

```
pnpm dev
```

Or run a single app:

```
pnpm --filter web dev
pnpm --filter @lythium/api dev
```

# Tests

Web unit + e2e tests:

```
pnpm --filter web test
```

# ly CLI

The CLI is linked globally via `pnpm link` from the `packages/cli` directory. After linking, `ly` is available as a global command. If the CLI isn't available, run:

```
cd packages/cli && pnpm link
```

Rebuild after making changes to CLI source:

```
pnpm --filter @lythium/cli build
```

# Linear

All issues are tracked in the **Lythium** team on Linear. Use this team for any issue lookups, creation, or updates.

# Branch Naming

Use the format `[type]/[ticket#]-[description]`, where `type` is the conventional commit type. Examples:

- `feat/lyt-6-web-ui-design`
- `fix/lyt-3-cli-output-formatting`
- `docs/lyt-5-local-dev-setup`

# Commits

Use conventional commits for all commit messages: `type(scope): description`. Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

# Checking Work

After completing any work, run `pnpm biome ci` to ensure that linting and style guides are maintained. Fix any issues that are reported.

# Making Commits

Use the `--no-gpg-sign` argument when committing — GPG signing is handled externally.

## Multiple Agents

When utilizing multiple agents, ensure that you are creating stacked branches utilizing our `ly` cli whenever possible.

Changes should be as small as possible for ease of review.
