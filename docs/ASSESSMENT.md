# MAL Engineering Productivity Platform — Written Response

Context: ~8 squads, ~30 engineers, fintech (borderless finance). Grounded in the
system at https://dev-pulse-web.onrender.com — not a hypothetical.

---

## Section 1 — Metric Design

Two questions only: *Is delivery safer and faster?* (leadership) and *Where is
my squad’s flow blocked this week?* (leads). Every metric comes from systems of
record — never spreadsheet entry.

### Full metric set

| Metric | Source | Computation | Anti-gaming |
| --- | --- | --- | --- |
| **Deployment frequency** | GitHub Actions (prod-signal workflows / Environments) | Successful prod deploys ÷ days; report deploys/day + DORA band | Count only named production success; skip/cancel out. Inflated pipelines show against merge volume and batch size |
| **Lead time for changes** | Commits + Actions head SHAs | Per success: commits via compare(`prev`…`head`); LT = deploy finish − commit author; **p50 / p95** | Commit→production, not PR-merge. Force-push caveat documented. Merging without shipping does not help |
| **Change failure rate** | Run status + reverts + linked incidents | Failures ÷ completed deploy attempts; failure = failed run **or** revert of shipped SHA **or** incident | One signal is gameable; three are not. Green CI + revert still counts |
| **Failed-deploy recovery (MTTR)** | Same signals + next success / resolve | Median failure → next successful prod deploy (or incident resolve) | Clock stops only on a real success/resolve in the system of record |
| **Review responsiveness** | PR + review comments | p50/p95 hours ready/open → first non-author review; bots out | Self-review/bot noise filtered; empty LGTM without comment is a known blind spot |
| **Change batch size** | Deploy commit sets + PR churn | Median commits/successful deploy; secondary median lines/merged PR | Explains lead-time moves; no-op pipeline spam → tiny batches + flat outcomes |
| **Merge throughput** | Merged PRs (bots out) | Merges / week | Never alone — always next to batch size |
| **Unplanned work ratio** | Linear/Jira (seeded until wired) | Completed bug+incident ÷ all completed (28d) | Mis-typing bugs as tasks is process debt we surface, not “fix” in code |
| **Flow efficiency** | Same PM source | Median (active ÷ create→complete) on completed items | Lead diagnostic only; board-hygiene dependent — never sole exec KPI |

### Deliberately excluded

- **Individual ranking / “top contributors”** — Goodhart machine at 30 people; kills trust.
- **Story points / velocity** — manual, inconsistent, easy to inflate.
- **Lines of code** — inverse to quality in fintech.
- **PR-merge time as “lead time”** — review latency only; hides release risk.
- **Composite “health score”** — opaque weights invite politics; show DORA bands with derivation.
- **On-call pages as primary CFR** — useful later; without deploy↔incident discipline it double-counts or misses silent failures. Incidents stay a *third* CFR signal.

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
     Canonical: commits, PRs, deployments,
     deployment_commits, incidents, work_items
                     ▼
           Metric engine (pure, windowed)
                     ▼
         metric_snapshots (definition_version, is_seeded)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   /squad/[id]              /exec
   (squad_lead)             (exec)
   detail + PR queue        aggregates only
```

Incremental sync (watermarks, ETags, request budget). Definition changes recompute
from `raw_events` without re-crawling. Org topology (squads ↔ repos ↔ deploy
signals) is config, not code.

### Who sees what — and why

| Audience | Sees | Does not see |
| --- | --- | --- |
| **Squad lead** | Own squad DORA/SPACE, per-repo breakdown, stalled open PRs (by PR, not person rank), WIP | Other squads; org-wide person lists |
| **Leadership (exec)** | Org DORA, squad comparison with k-anonymity (≥5 contributors), investment mix | Person IDs, repo lists as team proxies, squad drill-down |

Individual data appears in the lead view only where it unblocks flow (e.g. a PR
waiting days). It is never leaderboarded upward.

### Access and security

This system sits next to every engineer’s output:

1. **Auth** — session JWT (`SESSION_SECRET`), httpOnly / Secure / SameSite.
2. **Authz in the data layer** — `requireExec` / `requireSquadAccess` on every
   page and API. Middleware redirects UX; APIs return 401/403.
3. **Row-level squad scope** — session `squadId` must match; exec cannot open `/squad/*`.
4. **Payload design** — exec assemblers never read contributor identifiers.
5. **k-anonymity** — squads below the floor suppressed in exec comparison.
6. **Audit log** — allow/deny on sensitive reads.
7. **Identity hashing** — contributor logins as salted hashes, not raw handles.

Demo credentials are for grading; production swaps to Mal SSO (OIDC) with the
same role claims — the guard surface does not change.

### Extending beyond engineering (no rebuild)

| Layer | Engineering today | Risk / Marketing tomorrow |
| --- | --- | --- |
| Connector | GitHub + Actions | Case system / campaign analytics |
| Canonical | commits, deploys, PRs | cases, releases, campaigns |
| Metrics | DORA / SPACE defs | Domain defs, same snapshot schema |
| Config | squads ↔ repos | teams ↔ product surfaces |
| Views / RBAC | exec vs squad_lead | exec vs domain_lead — same guards |

New domain = connector + config + metric definitions. Raw store, snapshotter,
authz, and view shells stay. Risk: “policy change lead time” / “false positive
rate” over case events. Marketing: “campaign ship frequency” / “rollback rate”
over release events — same pipeline shape.

---

## Section 3 — 90-Day Execution Plan

Solo builder at Mal. Bias to a usable leadership proof over feature breadth.
Public stand-ins prove plumbing; Mal private repos + Environments are the cutover.

### Days 1–30 — Foundation and trust

**Ship:** Deployed app + Postgres + bootstrap; demo roles (exec + two squad leads);
schema, raw store, synthetic seed with Seeded badges; GitHub + Actions connectors,
normalizer, four DORA + review/batch metrics; `/exec` and `/squad` with
server-side RBAC + access verification script; config-driven squad/repo/deploy
mapping.

**Don’t build:** Live Linear/Jira, SSO, mobile, Slack bots, custom domains,
multi-region, ML scoring.

**Exit:** Leadership opens `/exec` on a public URL; eng lead sees own squad only;
cross-role API calls 403.

### Days 31–60 — Mal ground truth

**Ship:** Point config at Mal prod repos; prefer GitHub Environments / Deployments
over workflow-name proxies; raise sync budget/scheduling; durable watermarks;
wire Linear/Jira for unplanned work + flow efficiency (drop seed); exec investment
mix from real issue types; freshness + failure honesty in UI; rotate secrets / SSO prep.

**Don’t build:** Per-person dashboards, OKR product, warehouse export, multi-tenant SaaS.

**Exit:** ≥2 Mal squads show live (non-proxy) deploy signals; Seeded badges gone
from Mal DORA tiles.

### Days 61–90 — Leadership habit and proof

**Ship:** Weekly auto-sync reliability; short “what changed” strip on `/exec`
(band moves + unplanned-work direction); deploy-signal confidence per repo in UI;
one leadership review using only `/exec` (no spreadsheets); freeze scope — fix
only correctness and trust bugs.

**Don’t build:** Auto-remediation, eng performance reviews, cross-company
benchmarks, mobile apps, rewrite onto a service mesh.

### Day-90 proof number

**Single number:** Org **p50 lead time for changes** (hours), rolling 28 days, on
Mal services that use a GitHub Environment (or equivalent) as the production
signal — `/exec` → Delivery performance → Lead Time for Changes.

**How leadership checks it**
1. Open the dashboard URL.
2. Sign in with the leadership account.
3. Read the Lead Time tile: value, DORA band, trend sparkline.
4. Confirm freshness shows a recent successful sync.
5. Confirm the tile is **not** labeled Seeded.

**Success:** the number is (a) from Mal production deploys, (b) updated by sync
with no manual entry, and (c) used in a leadership review vs the prior 28-day
window — direction over an arbitrary hour target. Secondary: CFR band did not
regress while lead time moved.

---

## Section 4 — What You’d Change at 10× Scale

**Reverse:** A **single Next.js process** owns HTTP, sync/cron, normalization,
and metric materialization against Postgres.

At ~30 engineers that is correct: one deployable, one failure domain, fast
iteration. At 10× engineers/repos/events, sync and recompute contend with request
latency; single-instance cron bottlenecks; a bad metric job can take down the UI.

**Replace with:** Same logical pipeline, split runtime:

- **Web** — Next.js, read-only against `metric_snapshots` (+ thin freshness).
- **Worker** — sync + normalize + materialize (queue/cron), same DB.
- **Optional read replica** for exec under concurrent load.

Connectors, raw store, definition versioning, and RBAC stay. The reversal is
deployment topology, not the data model — which is why the append-only raw layer
and pure metric functions were the right early bet.
