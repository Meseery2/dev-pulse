# Dev Pulse — Engineering Productivity Dashboard

Role-scoped DORA and flow metrics for engineering leads and the CEO office.
Single Next.js app + Postgres, with live GitHub ingestion and a deterministic
seed so the UI is always demoable.

## Live dashboard

| | |
| --- | --- |
| **URL** | https://dev-pulse-web.onrender.com |
| **Health** | https://dev-pulse-web.onrender.com/api/health |
| **Host** | Render (free web service + Postgres) |
| **Auto-deploy** | On push to `main` |
| **Ingestion** | Live GitHub sync enabled (`GITHUB_TOKEN` set on Render) |

### Demo logins

| Username | Password | Lands on | Role |
| --- | --- | --- | --- |
| `admin` | `exec-demo-2026` | `/exec` | Exec — org aggregates only (no person-level rows) |
| `manager1` | `runtime-demo-2026` | `/squad/runtime` | Squad lead — Runtime |
| `manager2` | `experience-demo-2026` | `/squad/experience` | Squad lead — Experience |

Access control is enforced server-side (`requireRole`), not by URL alone.

### What each view shows

- **`/exec`** — Org-level DORA + SPACE/flow roll-ups, squad comparison with a
  k-anonymity floor, investment mix. Never serializes person identifiers.
- **`/squad/[id]`** — Squad DORA tiles, per-repo breakdown, stalled PR review
  queue, WIP. Person-level detail only where it unblocks flow.

## Repository

- **GitHub:** https://github.com/Meseery2/dev-pulse
- **Origin:** https://cursor.com/codebase/mohamed-elmeseery/dev-pulse

## Live vs seeded data

Configured in [`config/sources.json`](config/sources.json).

| Source | Provenance | Notes |
| --- | --- | --- |
| `honojs/hono`, `withastro/starlight` | **Live** (Runtime squad) | GitHub REST + Actions when `GITHUB_TOKEN` is set |
| `pmndrs/zustand`, `TanStack/query` | **Live** (Experience squad) | Same |
| `northwind/payments-*` | **Seeded** (Payments squad) | Synthetic; no public repo equivalent |
| Flow efficiency / unplanned work | **Seeded** | Project-management path; labeled in the UI |

Seeded rows carry `is_seeded` and surface a **Seeded** badge in the UI.

### Sync

- **Endpoint:** `POST /api/cron/sync` with `Authorization: Bearer $CRON_SECRET`
- **Local:** `npm run data:sync`
- Bootstrapping on Render runs schema + demo accounts + seed-if-empty, then
  serves. Live sync is separate (cron or manual POST above).

## Quick start (local)

```bash
cp .env.example .env.local
# set DATABASE_URL (and SESSION_SECRET ≥ 16 chars)
npm ci
npm run db:bootstrap
npm run dev
```

Open [http://localhost:44817](http://localhost:44817).

Optional: set `GITHUB_TOKEN` in `.env.local`, then `npm run data:sync`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string |
| `SESSION_SECRET` | Yes | JWT signing (≥ 16 characters) |
| `CRON_SECRET` | Yes (for sync) | Bearer token for `/api/cron/sync` |
| `GITHUB_TOKEN` | No | Enables live GitHub ingestion |
| `IDENTITY_SALT` | No | Hash salt for contributor identities |
| `ADMIN_PASSWORD` / `MANAGER1_PASSWORD` / `MANAGER2_PASSWORD` | No | Override demo passwords |

## Deploy on Render

Repo includes [`render.yaml`](render.yaml) and a production [`Dockerfile`](Dockerfile).

Current production service (Option B — git-backed web service):

1. [Render GitHub App](https://github.com/apps/render/installations/new) has
   access to **`Meseery2/dev-pulse`**.
2. Web service **`dev-pulse-web`** from this repo, branch `main`:
   - **Build:** `npm ci --include=dev && npm run build`
   - **Start:** `npx tsx scripts/bootstrap.ts && npm start`
   - **Health check:** `/api/health`
3. Env: `DATABASE_URL` (from Render Postgres `dev-pulse-db`),
   `SESSION_SECRET`, `CRON_SECRET`, `IDENTITY_SALT`, and `GITHUB_TOKEN`.

Dashboard: https://dashboard.render.com/web/srv-davvg3gu01pc7389vi5g

> Build must use `--include=dev` so `@tailwindcss/postcss` is available during
> `next build` (production `npm ci` would omit it).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run db:bootstrap` | Schema + accounts + seed-if-empty + snapshots |
| `npm run db:push` | Apply schema only |
| `npm run db:seed` | Force synthetic seed + snapshots |
| `npm run data:sync` | Live GitHub sync |
| `npm run data:refresh` | Re-normalize + rematerialize snapshots |
| `npm run test` | Unit tests (metrics, etc.) |

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind · shadcn/ui · Postgres ·
Drizzle · GitHub REST/Actions connectors · Recharts
