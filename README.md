# Dev Pulse — Engineering Productivity Dashboard

Role-scoped DORA and flow metrics for engineering leads and the CEO office.
Built as a single Next.js app with Postgres, GitHub connectors, and a
deterministic seed so the UI is demoable without credentials.

## Quick start (local)

```bash
cp .env.example .env.local
# set DATABASE_URL to a local Postgres instance
npm ci
npm run db:bootstrap
npm run dev
```

Open [http://localhost:44817](http://localhost:44817).

## Demo accounts

| Username   | Password            | Role                         |
| ---------- | ------------------- | ---------------------------- |
| `admin`    | `exec-demo-2026`    | Exec — org aggregates only   |
| `manager1` | `runtime-demo-2026` | Squad lead — Runtime         |
| `manager2` | `experience-demo-2026` | Squad lead — Experience   |

## Deploy on Render

This repo includes a Blueprint (`render.yaml`) and a production `Dockerfile`.

1. Connect **Cursor Origin** in Render → Account Settings → Git Deployment Credentials
   (workspace admin), *or* mirror the repo to GitHub and use that URL instead.
2. Apply the Blueprint:
   [https://dashboard.render.com/blueprint/new?repo=https://cursor.com/codebase/mohamed-elmeseery/dev-pulse](https://dashboard.render.com/blueprint/new?repo=https://cursor.com/codebase/mohamed-elmeseery/dev-pulse)
3. Optionally set `GITHUB_TOKEN` for live ingestion. Without it, the boot
   bootstrap loads synthetic (seeded) metrics.

Health check: `GET /api/health`. Sync: `POST /api/cron/sync` with
`Authorization: Bearer $CRON_SECRET`.

## Scripts

| Script                 | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `npm run db:bootstrap` | Schema + accounts + seed-if-empty + snapshots |
| `npm run db:push`      | Apply schema only                            |
| `npm run db:seed`      | Force synthetic seed + snapshots             |
| `npm run data:sync`    | Live GitHub sync                             |
| `npm run data:refresh` | Re-normalize + rematerialize snapshots       |

## Live vs seeded

Public GitHub repos configured in `config/sources.json` are live when
`GITHUB_TOKEN` is set. The Payments squad and project-management flow metrics
are always seeded and labeled in the UI.
