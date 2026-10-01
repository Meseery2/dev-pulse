# Engineering Productivity Dashboard — Plan

Planning document for the Engineering Productivity Lead assessment. No implementation
has started; this captures the interpretation, architecture, and open decisions.

---

## 1. What the assessment is actually testing

The literal ask is "a dashboard with four metrics and two logins." Reading between the
lines, the brief is probing five things:

| Signal | Where it shows up in the brief | How this plan answers it |
| --- | --- | --- |
| Can you wire real integrations? | "at least two **live** data sources" | Incremental sync with cursors, rate-limit handling, replayable raw event store |
| Do you understand DORA properly? | "at least two must be DORA metrics" | Lead time computed commit→production-deploy via SHA-range diff, not PR-merge time |
| Product judgment across audiences | "two distinct audiences" | Different questions per view, not the same chart at two zoom levels |
| Is your access control real? | "not just different URLs" | Server-side role guards; exec API never serializes person-level rows |
| Intellectual honesty | "which metrics are live vs. seeded", "one known limitation" | `is_seeded` flag flows from DB into a visible UI badge, not just prose in a README |

The single hardest technical problem here — and the thing most submissions get wrong — is
the **deployment-to-commit join**. Lead Time for Changes is defined as *time from code
committed to code running in production*. That requires knowing which commits were
contained in each production deploy. The common shortcut (PR opened → PR merged) measures
review latency and silently excludes the entire release pipeline. This plan does the real
join and documents the caveats.

---

## 2. Metric definitions

Definitions are versioned in the database (`definition_version`), so changing one is
auditable and triggers a recompute rather than silently rewriting history.

### DORA (all four)

**1. Deployment Frequency**
Count of *successful* production deployments per repository per period, aggregated to
squad and org. Reported as deploys/day plus the DORA performance band
(Elite / High / Medium / Low).
Source: GitHub Actions workflow runs (or the GitHub Deployments API) filtered to a
configurable production signal — see §6.

**2. Lead Time for Changes**
For each successful production deploy `D` at time `t` with head SHA `s`:
- commit set `C` = commits reachable from `s` but not from the previous successful
  production deploy SHA `s_prev`, via `GET /repos/{owner}/{repo}/compare/{s_prev}...{s}`
- per-commit lead time = `t − authored_at(commit)`
- report **p50 and p95** across all commits in the window (the mean is useless here; the
  distribution is heavily right-skewed)

*Known distortions, to be documented:* rebases and force-pushes rewrite author dates;
long-lived branches inflate the tail; merge commits are excluded from the numerator set.

**3. Change Failure Rate**
`failed production deploys / total production deploys` over the window. A deploy counts as
failed if, within a configurable window (default 24h), any of these hold:
- the deployment run concluded `failure`
- a revert commit lands that reverts a SHA contained in that deploy's commit set
- an incident work item is created and linked to the deploy window

*Why three signals:* no single one is reliable on its own. Reverts catch bad code that
deployed cleanly; run failures catch pipeline breakage; incidents catch user-visible
problems with no code signal at all. The README will be explicit that this is a heuristic.

**4. Failed Deployment Recovery Time (MTTR)**
Median time from failure signal → the next successful production deploy to the same
repo/environment, or incident resolution timestamp where an incident is linked.

### SPACE-derived (beyond the required two)

**5. Review Responsiveness** — p50/p95 hours from PR ready-for-review to first review by
someone other than the author. SPACE: *Collaboration & Communication*. This is the metric
engineering leads can actually act on tomorrow.

**6. Change Batch Size** — median `additions + deletions` per merged PR, plus the share of
PRs over 400 changed lines. SPACE: *Efficiency & Flow*. Batch size is upstream of lead time
and review latency; it explains *why* the DORA numbers look the way they do.

**7. Flow Efficiency & Unplanned Work Ratio** (project-management source) — time in active
states as a fraction of total cycle time, and the share of completed items typed as
bug/incident. The unplanned-work ratio is the one metric here that a CEO-office audience
intuitively understands without a tutorial.

---

## 3. Architecture

A single deployable Next.js application, layered so that each stage can be tested and
replayed independently.

```
GitHub REST ─┐
GH Actions ──┼─► Connectors ──► raw_events ──► Normalizer ──► canonical tables
PM tool ─────┘   (pure IO)     (append-only)   (pure fns)     (commits, PRs,
                                                               deployments,
                                                               incidents,
                                                               work_items)
                                                                    │
                                                                    ▼
                                                            Metric engine
                                                             (pure fns)
                                                                    │
                                                                    ▼
                                                           metric_snapshots
                                                                    │
                                              ┌─────────────────────┴────────┐
                                              ▼                              ▼
                                      /squad (eng_lead)                /exec (exec)
                                   squad detail, person-level      org aggregates only,
                                   where operationally useful      k-anonymity floor
```

**Why an append-only raw store.** Metric definitions will change — that is the nature of
this work. Keeping immutable raw payloads means a definition change triggers a recompute
from local data instead of a full re-crawl of an API with a 5,000 req/hr ceiling. It also
makes the normalizer and metric engine pure functions over fixtures, which makes them
genuinely unit-testable.

**Layers**

1. **Connectors** (`lib/connectors/*`) — one module per source behind a narrow interface
   (`fetchSince(cursor): AsyncIterable<RawEvent>`). Pure IO: auth, pagination, conditional
   requests via ETag, token-bucket throttling, `Retry-After` honouring. No business logic.
2. **Raw store** — `raw_events(source, kind, external_id, payload jsonb, ...)` with a
   uniqueness constraint making ingestion idempotent; re-running a sync is a no-op.
3. **Normalizer** — deterministic mapping from raw payloads to the canonical model.
4. **Metric engine** — pure, windowed (rolling 7/28/90d), grouped by org/squad/repo.
   Materialised into `metric_snapshots` so serving reads are fast, consistent, and carry
   their own provenance (`numerator`, `denominator`, `sample_size`, `is_seeded`).
5. **Orchestration** — `/api/cron/sync` guarded by a shared secret, driven by a scheduled
   job. Per-source watermarks in `sync_state`; one source failing does not block the other.
   Every run is recorded in `sync_runs` and surfaced in the UI as a data-freshness
   indicator — a dashboard that silently serves stale numbers is worse than no dashboard.

### Proposed schema (sketch)

```
sources, sync_state, sync_runs
raw_events(id, source, kind, external_id, payload, occurred_at, fetched_at)
repositories, teams, team_repositories
people(id, source_login_hash, display_name, team_id, is_bot)
commits(sha, repo_id, author_person_id, authored_at, additions, deletions, reverts_sha)
pull_requests(id, repo_id, author_person_id, opened_at, ready_at, first_review_at,
              merged_at, additions, deletions, changed_files, merge_commit_sha)
deployments(id, repo_id, environment, status, head_sha, started_at, finished_at)
deployment_commits(deployment_id, sha)
incidents(id, source, repo_id, deployment_id, started_at, resolved_at, origin)
work_items(id, source, external_key, team_id, type, state, created_at, started_at,
           completed_at, labels)
metric_snapshots(metric_key, scope_type, scope_id, period_start, period_end, value,
                 numerator, denominator, sample_size, definition_version, is_seeded)
```

---

## 4. Access control

Two roles, `eng_lead` and `exec`, carried on the session token.

- Enforcement lives in a server-side `requireRole()` guard applied in every route handler
  and server component data function — middleware alone is routing convenience, not
  security.
- **The exec endpoints never serialize person-level rows.** Aggregation happens in SQL
  before the data reaches the response, so there is nothing for a browser devtools session
  to uncover.
- **k-anonymity floor:** any grouping with fewer than 5 contributors is suppressed in the
  exec view rather than rounded, preventing deanonymisation of small squads.
- Tests assert both halves: an authenticated `exec` calling a squad endpoint receives 403,
  and exec response payloads contain zero person identifiers.

**A position worth stating explicitly in the README:** individual-level data appears in the
engineering-lead view only where it is operationally necessary to unblock flow (e.g. "this
PR has been waiting 4 days on this reviewer"). It is never ranked, never leaderboarded, and
never exposed upward. Measuring individuals upward is how these systems become Goodhart
machines and lose the trust that makes them useful.

---

## 5. The two views

**Engineering lead — `/squad`**
Squad selector. Four-up DORA tiles with trend sparklines and DORA band targets. PR flow
funnel (opened → ready → first review → merged → deployed) exposing where time is actually
lost. Review latency distribution. An actionable list of stalled open PRs. WIP by state.
Per-repo breakdown. The organising question: *where is my squad's flow blocked this week?*

**CEO office — `/exec`**
Org-level only. Delivery health composite (explicitly weighted, with the weights shown —
no black-box score). Four DORA trends quarter-over-quarter against industry bands.
Investment mix (feature vs. bug vs. maintenance, from issue type/labels). Reliability
framed as risk exposure rather than as engineering trivia. A plain-English "what changed
this quarter" summary. No names, no repo lists used as a proxy for team identity. The
organising question: *is engineering getting faster or slower, and what is it working on?*

---

## 6. Data sources: live vs. seeded

**Live (proposed default, requires only a GitHub PAT):**
- **GitHub REST** — commits, pull requests, reviews, revert detection.
- **GitHub Actions** — workflow runs as the deployment signal.

Proposed targets: this project's own repository (so the dashboard measures the pipeline
that builds it — genuinely real data, and a good demo), plus one or two high-volume public
repositories for statistical body.

**The production-deploy signal is configurable per repository** — a workflow file name, a
GitHub Environment name, or a tag pattern. Public repositories rarely have a literal
`production` environment, so this configurability is what lets the same code run against
public repos today and a real org's repos unchanged.

**Seeded (unless credentials are provided):**
- Project-management data (Linear or Jira) for flow efficiency, unplanned work, and
  incident linkage.

The synthetic generator will be deterministic (fixed seed) and distributionally realistic:
log-normal lead times, weekday-skewed deploy cadence, ~15% change failure rate, clustered
incidents. Every seeded row carries `is_seeded = true`, which propagates into a visible
badge in the UI — not just a line in the README.

---

## 7. Reliability & testing

- Unit tests on every metric function against fixture datasets with hand-verified expected
  values, including the awkward cases: zero deploys in a window, a single deploy with no
  predecessor SHA, force-pushed history, bot-authored commits.
- Connector contract tests against recorded HTTP fixtures, so CI never depends on a live
  API or a token.
- RBAC integration tests (403 enforcement + no-PII assertions on exec payloads).
- CI on GitHub Actions: typecheck, lint, test, build — which then becomes live input data
  for the dashboard itself.

**Known risks**
- GitHub rate limits (5k/hr authenticated) → incremental cursors, ETags, raw-store replay.
- Public repos may lack clean production-deploy signals → configurable deploy definition.
- Free-tier hosting spin-down causes cold starts → documented; scheduled sync mitigates.
- Revert-based change-failure detection has both false positives and false negatives → to
  be stated plainly rather than presented as ground truth.

---

## 8. Proposed build sequence

Ordered so that nothing downstream is blocked on credential access.

0. Scaffold, CI, auth skeleton with two demo roles.
1. Schema + deterministic synthetic seed generator — unblocks all UI work immediately.
2. GitHub connector (commits, PRs, reviews) + Actions connector (deploys).
3. Normalizer, deployment↔commit join, metric engine, metric tests.
4. Both views, RBAC, access-control tests.
5. Deploy, scheduled sync, README with the live/seeded matrix and the known limitation.

---

## 9. Defaults assumed where unspecified

Stack: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Postgres, Auth.js with
role claims, Recharts. Squad mapping from a committed config file plus CODEOWNERS. Demo
credentials for both roles published in the README so a grader can log in immediately.
