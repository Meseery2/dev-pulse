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

## Repository

- **GitHub:** https://github.com/Meseery2/dev-pulse
- **Origin:** https://cursor.com/codebase/mohamed-elmeseery/dev-pulse

## Deploy on Render

This repo includes a Blueprint (`render.yaml`) and a production `Dockerfile`.

1. Connect the [Render GitHub App](https://github.com/apps/render/installations/new)
   and grant access to **`Meseery2/dev-pulse`**.
2. Create a **Web Service** from the GitHub repo (`main`), with:
   - Build: `npm ci --include=dev && npm run build`
   - Start: `npx tsx scripts/bootstrap.ts && npm start`
   - Health check: `/api/health`
   - Env: `DATABASE_URL` (from Render Postgres), `SESSION_SECRET`, `CRON_SECRET`
3. Optionally set `GITHUB_TOKEN` for live ingestion. Without it, boot
   bootstrap loads synthetic (seeded) metrics.

Live service: https://dev-pulse-web.onrender.com

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
