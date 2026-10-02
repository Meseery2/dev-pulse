# Dev Pulse — MAL Engineering Productivity Dashboard

Role-scoped DORA and flow metrics for **MAL** engineering leads and leadership.
Next.js web app + Postgres on Render, with live GitHub / GitHub Actions ingestion
and labeled synthetic data where live org systems are unavailable.

**Public URL:** https://dev-pulse-web.onrender.com  
**Health:** https://dev-pulse-web.onrender.com/api/health

---

## Requirements checklist

| Requirement | How this project meets it |
| --- | --- |
| ≥2 live data sources | **(1)** GitHub REST — commits, PRs, reviews · **(2)** GitHub Actions — workflow runs as the production-deploy signal |
| ≥4 metrics, ≥2 DORA | All **four DORA** metrics + SPACE (review responsiveness, change batch size) + Flow (merge throughput). Flow efficiency / unplanned work are seeded PM metrics |
| Eng-lead view | `/squad/[id]` — squad DORA, per-repo breakdown, stalled PR queue, WIP |
| CEO-office view | `/exec` — org roll-ups only; k-anonymity floor; no person-level rows in page or API |
| Real access control | Distinct credentials + server-side `requireRole` / `requireSquadAccess` (not URL-only). APIs enforce the same guards |
| Deployed web app | Render: https://dev-pulse-web.onrender.com |
| Live vs seeded documented | See [Live vs seeded](#live-vs-seeded) below |
| Known limitation | See [Known limitation](#known-limitation-to-fix-next) below |

---

## Demo logins

| Username | Password | Lands on | Role |
| --- | --- | --- | --- |
| `admin` | `exec-demo-2026` | `/exec` | MAL Leadership — org aggregates only |
| `manager1` | `runtime-demo-2026` | `/squad/runtime` | Squad lead — Runtime |
| `manager2` | `experience-demo-2026` | `/squad/experience` | Squad lead — Experience |

An `exec` session calling `/api/metrics/squad/*` receives **403**. A squad lead calling `/api/metrics/org` or another squad’s route also receives **403**. Verified with `scripts/verify-access.ts`.

---

## Data sources

Configured in [`config/sources.json`](config/sources.json).

### Live (require `GITHUB_TOKEN`)

| Source | API | What we ingest | Used for |
| --- | --- | --- | --- |
| **GitHub** | REST | Commits, pull requests, review comments | Lead time join, review responsiveness, batch size, merge throughput, cycle-related PR age |
| **GitHub Actions** | Actions / workflow runs API | Successful & failed production-signal runs | Deployment frequency, change failure rate, recovery time, deploy↔commit join |

Live repositories (public stand-ins for MAL squads):

- Runtime: `honojs/hono`, `withastro/starlight`
- Experience: `pmndrs/zustand`, `TanStack/query`

Production-deploy signal is **configurable per repo** (workflow name + branch) because public repos rarely have a literal `production` environment.

### Seeded (synthetic, labeled in UI)

| Source | What | Used for |
| --- | --- | --- |
| Synthetic generator | `mal/payments-api`, `mal/billing-worker` + work items | Payments squad DORA demos; **flow efficiency** and **unplanned work** (project-management shape) |

Seeded rows set `is_seeded` / `has_seeded_inputs`. The UI shows **Seeded** (fully synthetic scope) or **Mixed** (org aggregates that include some seeded inputs).

### Sync

- `POST /api/cron/sync` with `Authorization: Bearer $CRON_SECRET`
- Local: `npm run data:sync`
- Boot on Render: schema + accounts + seed-if-empty; live sync is separate

---

## Metrics

| Metric | Family | Provenance (with token) |
| --- | --- | --- |
| Deployment Frequency | DORA | Live (Actions) |
| Lead Time for Changes | DORA | Live (commits ↔ deploy SHA join) |
| Change Failure Rate | DORA | Live (failed runs / reverts / incidents) |
| Failed Deployment Recovery Time (MTTR) | DORA | Live |
| Review Responsiveness | SPACE | Live (PR → first non-author review) |
| Change Batch Size | SPACE | Live (commits per deploy / PR size) |
| Merge Throughput | Flow | Live |
| Flow Efficiency | Flow | **Seeded** (PM work items) |
| Unplanned Work | Flow | **Seeded** (PM work items) |

---

## Setup (local)

```bash
cp .env.example .env.local
# Required: DATABASE_URL, SESSION_SECRET (≥ 16 chars)
# Optional: GITHUB_TOKEN, CRON_SECRET, IDENTITY_SALT
npm ci
npm run db:bootstrap
npm run dev
```

Open [http://localhost:44817](http://localhost:44817).  
With a token: `npm run data:sync`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres |
| `SESSION_SECRET` | Yes | JWT signing (≥ 16 characters) |
| `CRON_SECRET` | For sync endpoint | Bearer for `/api/cron/sync` |
| `GITHUB_TOKEN` | For live ingestion | GitHub REST + Actions |
| `IDENTITY_SALT` | No | Contributor identity hashing |
| `*_PASSWORD` | No | Override demo passwords |

### Deploy (Render)

Git-backed service from https://github.com/Meseery2/dev-pulse (`main`):

- Build: `npm ci --include=dev && npm run build`
- Start: `npx tsx scripts/bootstrap.ts && npm start`
- Health: `/api/health`
- Env: `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `IDENTITY_SALT`, `GITHUB_TOKEN`

Also see [`render.yaml`](render.yaml). Dashboard: https://dashboard.render.com/web/srv-davvg3gu01pc7389vi5g

---

## Known limitation (to fix next)

**Production-deploy signal on public repositories is an imperfect proxy.**  
We map “production” to named workflow runs (e.g. `Release`, `cr`) because public repos rarely expose a true production environment. That can:

1. Count CI/release jobs that are not user-facing production deploys (inflating deployment frequency).
2. Produce very short lead times when the “deploy” SHA is close to author time on a release automation path.

**Next fix:** Prefer GitHub Deployments / Environments when present, fall back to workflow names, and surface per-repo signal confidence in the UI so a short lead time is never mistaken for Elite delivery without context.

Other follow-ups: raise the per-sync API budget / watermark pacing so large repos are not truncated mid-window; add a real Linear/Jira connector so flow metrics are live.

---

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run db:bootstrap` | Schema + accounts + seed-if-empty + snapshots |
| `npm run db:push` | Schema only |
| `npm run db:seed` | Force synthetic seed |
| `npm run data:sync` | Live GitHub + Actions sync |
| `npm run data:refresh` | Re-normalize + rematerialize |
| `npm run test` | Unit tests |
| `npx tsx scripts/verify-access.ts` | RBAC matrix against a running server |

## Stack

Next.js 16 · TypeScript · Tailwind · shadcn/ui · Postgres · Drizzle ·
GitHub REST + Actions connectors · Recharts · Render

## Written assessment

Metric design, architecture, 90-day plan, and scale reversal:

- Markdown: [`docs/ASSESSMENT.md`](docs/ASSESSMENT.md)
- PDF: [`docs/ASSESSMENT.pdf`](docs/ASSESSMENT.pdf)

## Repository

- GitHub: https://github.com/Meseery2/dev-pulse
- Origin: https://cursor.com/codebase/mohamed-elmeseery/dev-pulse
