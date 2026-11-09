# GitHub App settings

Lythium uses a GitHub App for two jobs:

1. **Webhooks** (`apps/github-app`): receives PR events and mirrors PR and stack data into the database.
2. **User sign-in** (web app, planned): GitHub OAuth through the App's user-to-server flow, so the API can call GitHub with the caller's token (`Authorization: Bearer`).

This page is the source of truth for the App's configuration, so the App can be recreated. It contains no secrets. Local setup steps (LYT-5) should link here.

## Settings

### Repository permissions

| Permission | Access | Needed by |
| --- | --- | --- |
| Metadata | Read | Always on |
| Pull requests | Read and write | Details, comments, reviews, merge (LYT-53, 56, 57, 58) |
| Contents | Read and write | Compare/diff (existing endpoint); merge and branch deletion (LYT-58) |
| Checks | Read | PR checks (LYT-55) |
| Commit statuses | Read | PR checks for repos that use statuses (LYT-55) |

No organization or account permissions. Add more only when a ticket needs them.

### Subscribed events

- Pull request (handled today: `opened`, `edited`, `synchronize`, `reopened`, `closed`)
- Pull request review (reserved for review state sync)
- Pull request review comment (reserved for comment sync)
- Check run (reserved for CI status sync)

The webhook service currently handles only `pull_request`. The other events can be subscribed to now so adding handlers later does not trigger a permissions re-approval.

### URLs

| Field | Local dev | Production |
| --- | --- | --- |
| Callback URL | `http://localhost:5173/auth/github/callback` | `https://<production web origin>/auth/github/callback` |
| Setup URL | `http://localhost:5173/auth/github/installed` | `https://<production web origin>/auth/github/installed` |
| Webhook URL | smee.io channel URL (see below) | `https://<production webhook host>/webhook` |

Setup URL is where users land after installing the App. The route is defined by the installation ticket (LYT-68). Update this page if the path changes. Enable "Redirect on update".

### Other options

- **Expire user authorization tokens:** on. The web app must refresh tokens (LYT-66).
- **Request user authorization (OAuth) during installation:** on.
- **Device flow:** off for now. Turn it on when the CLI adopts device login (LYT-69).
- **Webhook secret:** set. Must match `GITHUB_WEBHOOK_SECRET`.
- **Where can this App be installed:** any account, once production is ready. Use "Only on this account" while developing.

## Environments

Use two Apps: a development App and a production App. A single App has one callback URL list and one webhook URL, so sharing it makes local callbacks and the smee webhook collide with production.

| | Development App | Production App |
| --- | --- | --- |
| Name | `Lythium (dev)` | `Lythium` |
| Installable by | Owner only | Anyone |
| Webhook URL | smee.io channel | Production `/webhook` |
| Callback URL | `localhost:5173` | Production web origin |

### Environment variables

Each environment gets its own App, so values differ per environment. Never commit them.

| Variable | Used by | Notes |
| --- | --- | --- |
| `GITHUB_APP_ID` | `apps/github-app` | App ID, shown on the App's settings page |
| `GITHUB_APP_PRIVATE_KEY` | `apps/github-app` | **Path** to the downloaded `.pem` file |
| `GITHUB_WEBHOOK_SECRET` | `apps/github-app` | Same value as the App's webhook secret |
| `SMEE_PROXY` | `apps/github-app` | Dev only. Your smee.io channel URL |
| `DATABASE_URL` | `apps/github-app` | Postgres connection string |
| `PORT` | `apps/github-app` | Defaults to 3001 |

The OAuth client ID and secret variables will be added by the login ticket (LYT-64).

### Local setup

1. Create the development App under your account (Settings, Developer settings, GitHub Apps) with the settings above.
2. Create a channel at <https://smee.io/new> and use its URL as both the App's webhook URL and `SMEE_PROXY`.
3. Generate a private key, save the `.pem` outside the repo, and point `GITHUB_APP_PRIVATE_KEY` at it.
4. Install the App on a test repository.
5. Run `pnpm --filter @lythium/github-app dev`. In dev (`NODE_ENV` not `production`) the service forwards smee events to `http://localhost:3001/webhook`.

## Changing settings

Changing permissions makes GitHub ask every existing installation to accept the new permissions, and the App has no access to new permissions until they do. Apply permission changes before real users install, and batch them.
