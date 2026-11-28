# Lythium

Stacks, Opened Up

## Inspiration

Graphite
## Docs

- [GitHub App settings and environments](docs/github-app.md)

## Environment

Each app that reads environment variables has a committed `.env.example` listing every variable with its purpose, requiredness and default: [`apps/web`](apps/web/.env.example), [`apps/api`](apps/api/.env.example), [`apps/github-app`](apps/github-app/.env.example) and [`packages/db`](packages/db/.env.example). Copy one to `.env` in the same directory. Only `apps/web` and `apps/github-app` load `.env` themselves; for `apps/api` and `packages/db`, export the variables into your shell first (`set -a; . .env; set +a`). `packages/db` reads `DB_URL` while the apps read `DATABASE_URL`.
