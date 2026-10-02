import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Append-only landing zone. Every connector writes here first and nothing else
 * talks to the source APIs. Because payloads are immutable and replayable, a
 * change to a metric definition is a local recompute rather than a re-crawl
 * against a rate-limited API.
 */
export const rawEvents = pgTable(
  "raw_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    repoSlug: text("repo_slug"),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("raw_events_identity_idx").on(t.source, t.kind, t.externalId),
    index("raw_events_repo_kind_idx").on(t.repoSlug, t.kind),
  ],
);

/** Per-source incremental watermarks so a sync resumes instead of restarting. */
export const syncState = pgTable(
  "sync_state",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    resource: text("resource").notNull(),
    repoSlug: text("repo_slug"),
    cursor: text("cursor"),
    etag: text("etag"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("sync_state_identity_idx").on(t.source, t.resource, t.repoSlug)],
);

/**
 * One row per sync attempt. This is what powers the data-freshness indicator in
 * the UI: a dashboard that silently serves stale numbers is worse than one that
 * admits it is stale.
 */
export const syncRuns = pgTable("sync_runs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  status: text("status").notNull(), // running | success | partial | failed
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  requestsUsed: integer("requests_used").notNull().default(0),
  rowsWritten: integer("rows_written").notNull().default(0),
  rateLimited: boolean("rate_limited").notNull().default(false),
  message: text("message"),
});

export const squads = pgTable("squads", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
});

export const repositories = pgTable("repositories", {
  slug: text("slug").primaryKey(),
  squadId: text("squad_id").references(() => squads.id),
  defaultBranch: text("default_branch").notNull().default("main"),
  isSeeded: boolean("is_seeded").notNull().default(false),
});

/**
 * Contributors are stored as salted hashes only. No display names, no logins.
 * The product never needs to identify an individual; it needs to count distinct
 * contributors for k-anonymity checks and participation metrics.
 */
export const contributors = pgTable(
  "contributors",
  {
    id: text("id").primaryKey(),
    identityHash: text("identity_hash").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
  },
  (t) => [uniqueIndex("contributors_hash_idx").on(t.identityHash)],
);

export const commits = pgTable(
  "commits",
  {
    sha: text("sha").notNull(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repositories.slug),
    contributorId: text("contributor_id").references(() => contributors.id),
    authoredAt: timestamp("authored_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    /** Position on the default branch, newest = 0. Enables the deploy/commit join without extra API calls. */
    branchPosition: integer("branch_position"),
    isRevert: boolean("is_revert").notNull().default(false),
    revertsSha: text("reverts_sha"),
    isMerge: boolean("is_merge").notNull().default(false),
    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.repoSlug, t.sha] }),
    index("commits_repo_authored_idx").on(t.repoSlug, t.authoredAt),
  ],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repositories.slug),
    number: integer("number").notNull(),
    authorId: text("author_id").references(() => contributors.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    firstReviewAt: timestamp("first_review_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergeCommitSha: text("merge_commit_sha"),
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    isDraft: boolean("is_draft").notNull().default(false),
    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [
    uniqueIndex("pull_requests_repo_number_idx").on(t.repoSlug, t.number),
    index("pull_requests_repo_opened_idx").on(t.repoSlug, t.openedAt),
  ],
);

/**
 * A production deployment attempt. `status` is deliberately narrow: GitHub
 * reports conclusions such as `skipped`, `cancelled` and `action_required`
 * which are neither successes nor failures and must not land in either side of
 * the change-failure-rate ratio.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repositories.slug),
    environment: text("environment").notNull().default("production"),
    status: text("status").notNull(), // success | failure
    headSha: text("head_sha").notNull(),
    workflowName: text("workflow_name"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [index("deployments_repo_finished_idx").on(t.repoSlug, t.finishedAt)],
);

/** Commits contained in a deployment, resolved by diffing consecutive successful deploys. */
export const deploymentCommits = pgTable(
  "deployment_commits",
  {
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    repoSlug: text("repo_slug").notNull(),
    sha: text("sha").notNull(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.sha] })],
);

/**
 * A failure attributed to a deployment. `origin` records which of the three
 * detection signals fired, so the UI can show how a change failure was
 * identified rather than presenting a heuristic as ground truth.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    repoSlug: text("repo_slug")
      .notNull()
      .references(() => repositories.slug),
    deploymentId: text("deployment_id").references(() => deployments.id, { onDelete: "set null" }),
    origin: text("origin").notNull(), // failed_deploy | revert | work_item
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [index("incidents_repo_started_idx").on(t.repoSlug, t.startedAt)],
);

/** Project-management work items (Linear/Jira shape). Seeded unless credentials are supplied. */
export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalKey: text("external_key").notNull(),
    squadId: text("squad_id").references(() => squads.id),
    type: text("type").notNull(), // feature | bug | maintenance | incident
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    activeSeconds: integer("active_seconds"),
    isSeeded: boolean("is_seeded").notNull().default(false),
  },
  (t) => [index("work_items_squad_completed_idx").on(t.squadId, t.completedAt)],
);

/**
 * Materialised metric values. Serving reads never recompute. Each row carries
 * its own provenance (`numerator`, `denominator`, `sampleSize`, `isSeeded`,
 * `definitionVersion`) so a number in the UI can always be traced back to how
 * it was derived and which inputs it came from.
 */
export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: text("id").primaryKey(),
    metricKey: text("metric_key").notNull(),
    scopeType: text("scope_type").notNull(), // org | squad | repo
    scopeId: text("scope_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    windowDays: integer("window_days").notNull(),
    value: numeric("value"),
    secondaryValue: numeric("secondary_value"),
    numerator: numeric("numerator"),
    denominator: numeric("denominator"),
    sampleSize: integer("sample_size").notNull().default(0),
    contributorCount: integer("contributor_count").notNull().default(0),
    definitionVersion: text("definition_version").notNull(),
    isSeeded: boolean("is_seeded").notNull().default(false),
    hasSeededInputs: boolean("has_seeded_inputs").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("metric_snapshots_identity_idx").on(
      t.metricKey,
      t.scopeType,
      t.scopeId,
      t.periodEnd,
      t.windowDays,
    ),
    index("metric_snapshots_lookup_idx").on(t.scopeType, t.scopeId, t.metricKey, t.periodEnd),
  ],
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(), // exec | squad_lead
    squadId: text("squad_id").references(() => squads.id),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

/** Append-only authorization audit trail, including denials. */
export const accessLog = pgTable(
  "access_log",
  {
    id: text("id").primaryKey(),
    username: text("username"),
    role: text("role"),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    allowed: boolean("allowed").notNull(),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("access_log_at_idx").on(t.at)],
);
