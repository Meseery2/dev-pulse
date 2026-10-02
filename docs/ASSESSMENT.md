# MAL Engineering Productivity Platform — Written Response

Context: ~8 squads, ~30 engineers, fintech (borderless finance). This document
describes the metric set, architecture, and 90-day plan that the deployed system
implements. Live proof: https://dev-pulse-web.onrender.com

---

## Section 1 — Metric Design

For an organisation this size, the metric set must answer two questions without
turning into a surveillance product: *Is delivery getting safer and faster?*
(leadership) and *Where is my squad’s flow blocked this week?* (engineering
leads). Everything below is computed from source systems — never from
spreadsheet entry.

### Full metric set

| Metric | Source | Computation | Anti-gaming defence |
| --- | --- | --- | --- |
| **Deployment frequency** | GitHub Actions (production-signal workflows / Environments) | Successful production deploys ÷ days in window; report deploys/day + DORA band | Count only success on a named production signal; skip/cancel excluded. Splitting pipelines to inflate count is visible against merge volume and batch size |
| **Lead time for changes** | GitHub commits + Actions head SHAs | For each successful deploy, commits = compare(`prev_success`…`head`); lead time = deploy finish − commit author time; report **p50 / p95** | Uses commit→production, not PR-merge. Force-push shortens author dates (documented). Cannot “improve” by merging without shipping |
| **Change failure rate** | Actions run status + revert commits + linked incidents | Failed deploys ÷ all completed deploy attempts. Failure = failed run **or** revert of a shipped SHA **or** incident in window | Single signal is gameable; three independent signals are not. Clean green CI with a revert still counts |
| **Failed-deploy recovery (MTTR)** | Same failure signals + next success / incident resolve | Median time from failure signal → next successful production deploy (or incident resolution) | Stopping the clock requires a real success or resolve event in the system of record |
| **Review responsiveness** | GitHub PR + review comments | p50/p95 hours from ready/open → first non-author review; bots excluded | Self-reviews and bot noise excluded. Gaming via rubber-stamp bots is filtered; empty “LGTM” without a comment is a known blind spot (caveat in UI) |
| **Change batch size** | Deploy commit sets + PR additions/deletions | Median commits per successful deploy; secondary: median lines per merged PR | Explains *why* lead time moves. Inflating deploy count with tiny no-op pipelines shows up as tiny batches + flat outcomes |
| **Merge throughput** | GitHub merged PRs | Merges / week (bots excluded) | Never used alone; always read next to batch size so “merge more” cannot look like progress |
| **Unplanned work ratio** | Project tool (Linear/Jira; seeded until wired) | Completed bug+incident items ÷ all completed items (28d) | Leadership-legible risk signal. Gaming via mis-typing bugs as tasks is a process problem we surface, not a metric we “fix” in code |
| **Flow efficiency** | Same PM source | Median (active time ÷ create→complete) on completed items | Secondary diagnostic for leads; depends on board hygiene — labeled and never the sole exec KPI |

### Deliberately excluded

- **Individual ranking / “top contributors.”** At 30 people this becomes a Goodhart
  machine overnight and destroys the trust required for accurate tooling.
- **Story points / velocity.** Manual, inconsistent across squads, easy to inflate.
- **Lines of code written.** Inverse to quality in fintech; rewards noise.
- **PR-merge time as “lead time.”** Measures review latency only; hides release risk.
- **Composite “health score.”** Opaque weights invite politics; we show DORA bands
  and investment mix with the derivation visible instead.
- **On-call pages as primary CFR.** Useful later; without disciplined incident↔deploy
  linking it double-counts or misses silent failures. We keep incidents as a *third*
  CFR signal, not the only one.

---

## Section 2 — Platform Architecture

### Data flow

```
GitHub REST          GitHub Actions         Linear / Jira (later)
(commits, PRs,   →   (workflow runs)   →    (work items)
 reviews)                 │                      │
        └────────────┬────┴──────────────────────┘
                     ▼
              Connectors (IO only)
                     ▼
         raw_events (append-only, idempotent)
                     ▼
              Normalizer (pure)
                     ▼
     Canonical tables: commits, PRs, deployments,
     deployment_commits, incidents, work_items
                     ▼
           Metric engine (pure, windowed)
                     ▼
              metric_snapshots
              (definition_version, is_seeded)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   /squad/[id]              /exec
   (squad_lead)             (exec)
   detail + PR queue        aggregates only
```

Sync is incremental (watermarks, ETags, request budget). A definition change
recomputes from `raw_events` without re-crawling GitHub. Org topology
(squads ↔ repos ↔ deploy signals) lives in config, not code.

### Who sees what — and why

| Audience | Sees | Does not see |
| --- | --- | --- |
| **Squad lead** | Own squad DORA/SPACE, per-repo breakdown, stalled open PRs (by PR, not person ranking), WIP | Other squads; org-wide person lists |
| **Leadership (exec)** | Org DORA, squad comparison with k-anonymity floor (≥5 contributors), investment mix | Person IDs, repo lists as team proxies, squad drill-down |

Individual data appears in the lead view only where it unblocks flow (e.g. a PR
waiting days). It is never leaderboarded upward.

### Access and security

This system sits next to every engineer’s output. Controls are not cosmetic:

1. **Authentication** — session JWT (`SESSION_SECRET`), httpOnly / Secure / SameSite.
2. **Authorization in the data layer** — `requireExec` / `requireSquadAccess` on
   every page and API. Middleware only redirects UX; APIs return 401/403.
3. **Row-level squad scope** — `squad_lead` alone is insufficient; session
   `squadId` must match the requested squad. Exec cannot open `/squad/*`.
4. **Payload design** — exec assemblers never read contributor identifiers;
   aggregation happens before serialization.
5. **k-anonymity** — squads below the floor are suppressed in exec comparison.
6. **Audit log** — allow/deny on sensitive reads.
7. **Identity hashing** — contributor logins stored as salted hashes, not raw handles.

Demo credentials exist for grading; production would swap to Mal SSO (OIDC) with
the same role claims — the guard surface does not change.

### Extending beyond engineering (no rebuild)

The platform is domain-agnostic past the connector boundary:

| Layer | Engineering today | Risk / Marketing tomorrow |
| --- | --- | --- |
| Connector | GitHub + Actions | e.g. case system + campaign analytics |
| Canonical model | commits, deploys, PRs | cases, releases, campaigns |
| Metrics | DORA / SPACE definitions | domain definitions, same snapshot schema |
| Config | squads ↔ repos | teams ↔ product surfaces |
| Views / RBAC | exec vs squad_lead | exec vs domain_lead — same guard pattern |

New domain = new connector + config + metric definitions. Raw store, snapshotter,
authz, and view shells stay. Risk example: “policy change lead time” and “false
positive rate” as metrics over case/decision events; Marketing example: “campaign
ship frequency” and “rollback rate” over release events — same pipeline shape.

---

## Section 3 — 90-Day Execution Plan

Solo builder at Mal. Bias to a usable leadership proof over feature breadth.
Public stand-ins prove the plumbing; Mal private repos + Environments are the
production cutover.

### Days 1–30 — Foundation and trust

**Ship**
- Deployed app, Postgres, bootstrap, demo roles (exec + two squad leads).
- Schema, raw event store, synthetic seed with visible Seeded badges.
- GitHub + Actions connectors, normalizer, all four DORA + review/batch metrics
  on configured repos.
- `/exec` and `/squad` with server-side RBAC; access verification script.
- Config-driven squad/repo/deploy-signal mapping.

**Deliberately don’t build:** Linear/Jira live connector, SSO, mobile, Slack bots,
custom domains, multi-region, ML scoring.

**Exit check:** Leadership can log into `/exec` on a public URL; eng lead sees
own squad only; cross-role API calls 403.

### Days 31–60 — Mal ground truth

**Ship**
- Point config at Mal production repos; prefer GitHub Environments / Deployments
  over workflow-name proxies.
- Raise sync budget/scheduling; commit watermarks only after durable writes.
- Wire Linear (or Jira) for unplanned work + flow efficiency; drop seed for those.
- Exec investment mix from real issue types; freshness + failure honesty in UI.
- Harden secrets (SSO prep or at least rotated secrets, no README prod passwords).

**Deliberately don’t build:** Per-person dashboards, OKR product, data warehouse
export, multi-tenant SaaS packaging.

**Exit check:** At least two Mal squads show live (non-proxy) deploy signals;
Seeded badges gone from Mal DORA tiles.

### Days 61–90 — Leadership habit and proof

**Ship**
- Weekly auto-sync reliability; short “what changed” strip on `/exec` (band
  moves + unplanned-work direction).
- Document deploy-signal confidence per repo in UI.
- Run one leadership review using only `/exec` (no spreadsheets).
- Freeze scope; fix only correctness and trust bugs.

**Deliberately don’t build:** Auto-remediation, eng performance reviews,
cross-company benchmarks, mobile native apps, rewriting onto a mesh of services.

### Day-90 proof number

**Single number:** Org-level **p50 lead time for changes** (hours), rolling 28 days,
on Mal services that use a GitHub Environment (or equivalent) as the production
signal — shown on `/exec` → Delivery performance → Lead Time for Changes.

**How a non-technical leadership reviewer checks it**
1. Open https://dev-pulse-web.onrender.com (or Mal internal URL).
2. Sign in with the leadership account.
3. Read the Lead Time tile: value, Elite/High/Medium/Low band, trend sparkline.
4. Confirm the freshness line shows a recent successful sync (not stale).
5. Confirm the tile is **not** labeled Seeded.

**Success criterion for “the system is working”:** that number is (a) sourced from
Mal production deploys, (b) updated by sync without manual entry, and (c) discussed
in a leadership review against the prior 28-day window — direction matters more
than hitting an arbitrary hour target in the first quarter. Secondary glance:
change failure rate band did not regress while lead time moved.

---

## Section 4 — What You’d Change at 10× Scale

**Decision to reverse:** A **single Next.js process** owns HTTP, sync/cron,
normalization, and metric materialization, with snapshots computed in-process
against Postgres.

At ~30 engineers this is correct: one deployable, one failure domain, fast
iteration. At 10× engineers (and 10× repos/events), sync and recompute contend
with request latency; free/single-instance cron becomes a bottleneck; and a bad
metric job can take down the leadership UI.

**Replace with:** Keep the same logical pipeline, split the runtime:

- **Web** — Next.js, read-only against `metric_snapshots` (and thin freshness).
- **Worker** — sync + normalize + materialize (queue/cron), same DB.
- **Optional read replica** for exec dashboards under concurrent load.

Connectors, raw store, definition versioning, and RBAC stay. The reversal is
deployment topology, not the data model — which is why the append-only raw layer
and pure metric functions were the right early bet.
