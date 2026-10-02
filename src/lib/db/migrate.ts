import { getPool } from "./index";

/**
 * Schema is applied with plain idempotent DDL rather than a migration-file
 * chain. For a project of this size it keeps `npm run db:push` a single
 * safe-to-repeat command, including on a fresh Render deploy.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS raw_events (
     id text PRIMARY KEY,
     source text NOT NULL,
     kind text NOT NULL,
     external_id text NOT NULL,
     repo_slug text,
     payload jsonb NOT NULL,
     occurred_at timestamptz,
     fetched_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS raw_events_identity_idx ON raw_events (source, kind, external_id)`,
  `CREATE INDEX IF NOT EXISTS raw_events_repo_kind_idx ON raw_events (repo_slug, kind)`,

  `CREATE TABLE IF NOT EXISTS sync_state (
     id text PRIMARY KEY,
     source text NOT NULL,
     resource text NOT NULL,
     repo_slug text,
     cursor text,
     etag text,
     last_synced_at timestamptz
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sync_state_identity_idx ON sync_state (source, resource, repo_slug)`,

  `CREATE TABLE IF NOT EXISTS sync_runs (
     id text PRIMARY KEY,
     source text NOT NULL,
     status text NOT NULL,
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     requests_used integer NOT NULL DEFAULT 0,
     rows_written integer NOT NULL DEFAULT 0,
     rate_limited boolean NOT NULL DEFAULT false,
     message text
   )`,

  `CREATE TABLE IF NOT EXISTS squads (
     id text PRIMARY KEY,
     name text NOT NULL,
     description text NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS repositories (
     slug text PRIMARY KEY,
     squad_id text REFERENCES squads(id),
     default_branch text NOT NULL DEFAULT 'main',
     is_seeded boolean NOT NULL DEFAULT false
   )`,

  `CREATE TABLE IF NOT EXISTS contributors (
     id text PRIMARY KEY,
     identity_hash text NOT NULL,
     is_bot boolean NOT NULL DEFAULT false
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS contributors_hash_idx ON contributors (identity_hash)`,

  `CREATE TABLE IF NOT EXISTS commits (
     sha text NOT NULL,
     repo_slug text NOT NULL REFERENCES repositories(slug),
     contributor_id text REFERENCES contributors(id),
     authored_at timestamptz NOT NULL,
     committed_at timestamptz,
     branch_position integer,
     is_revert boolean NOT NULL DEFAULT false,
     reverts_sha text,
     is_merge boolean NOT NULL DEFAULT false,
     is_seeded boolean NOT NULL DEFAULT false,
     PRIMARY KEY (repo_slug, sha)
   )`,
  `CREATE INDEX IF NOT EXISTS commits_repo_authored_idx ON commits (repo_slug, authored_at)`,

  `CREATE TABLE IF NOT EXISTS pull_requests (
     id text PRIMARY KEY,
     repo_slug text NOT NULL REFERENCES repositories(slug),
     number integer NOT NULL,
     author_id text REFERENCES contributors(id),
     opened_at timestamptz NOT NULL,
     ready_at timestamptz,
     first_review_at timestamptz,
     merged_at timestamptz,
     closed_at timestamptz,
     merge_commit_sha text,
     additions integer,
     deletions integer,
     changed_files integer,
     is_draft boolean NOT NULL DEFAULT false,
     is_seeded boolean NOT NULL DEFAULT false
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pull_requests_repo_number_idx ON pull_requests (repo_slug, number)`,
  `CREATE INDEX IF NOT EXISTS pull_requests_repo_opened_idx ON pull_requests (repo_slug, opened_at)`,

  `CREATE TABLE IF NOT EXISTS deployments (
     id text PRIMARY KEY,
     repo_slug text NOT NULL REFERENCES repositories(slug),
     environment text NOT NULL DEFAULT 'production',
     status text NOT NULL,
     head_sha text NOT NULL,
     workflow_name text,
     started_at timestamptz NOT NULL,
     finished_at timestamptz NOT NULL,
     is_seeded boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS deployments_repo_finished_idx ON deployments (repo_slug, finished_at)`,

  `CREATE TABLE IF NOT EXISTS deployment_commits (
     deployment_id text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
     repo_slug text NOT NULL,
     sha text NOT NULL,
     PRIMARY KEY (deployment_id, sha)
   )`,

  `CREATE TABLE IF NOT EXISTS incidents (
     id text PRIMARY KEY,
     repo_slug text NOT NULL REFERENCES repositories(slug),
     deployment_id text REFERENCES deployments(id) ON DELETE SET NULL,
     origin text NOT NULL,
     started_at timestamptz NOT NULL,
     resolved_at timestamptz,
     is_seeded boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS incidents_repo_started_idx ON incidents (repo_slug, started_at)`,

  `CREATE TABLE IF NOT EXISTS work_items (
     id text PRIMARY KEY,
     source text NOT NULL,
     external_key text NOT NULL,
     squad_id text REFERENCES squads(id),
     type text NOT NULL,
     state text NOT NULL,
     created_at timestamptz NOT NULL,
     started_at timestamptz,
     completed_at timestamptz,
     active_seconds integer,
     is_seeded boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS work_items_squad_completed_idx ON work_items (squad_id, completed_at)`,

  `CREATE TABLE IF NOT EXISTS metric_snapshots (
     id text PRIMARY KEY,
     metric_key text NOT NULL,
     scope_type text NOT NULL,
     scope_id text NOT NULL,
     period_start timestamptz NOT NULL,
     period_end timestamptz NOT NULL,
     window_days integer NOT NULL,
     value numeric,
     secondary_value numeric,
     numerator numeric,
     denominator numeric,
     sample_size integer NOT NULL DEFAULT 0,
     contributor_count integer NOT NULL DEFAULT 0,
     definition_version text NOT NULL,
     is_seeded boolean NOT NULL DEFAULT false,
     has_seeded_inputs boolean NOT NULL DEFAULT false,
     computed_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS metric_snapshots_identity_idx
     ON metric_snapshots (metric_key, scope_type, scope_id, period_end, window_days)`,
  `CREATE INDEX IF NOT EXISTS metric_snapshots_lookup_idx
     ON metric_snapshots (scope_type, scope_id, metric_key, period_end)`,

  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     username text NOT NULL,
     password_hash text NOT NULL,
     role text NOT NULL,
     squad_id text REFERENCES squads(id),
     display_name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username)`,

  `CREATE TABLE IF NOT EXISTS access_log (
     id text PRIMARY KEY,
     username text,
     role text,
     action text NOT NULL,
     resource text NOT NULL,
     allowed boolean NOT NULL,
     reason text,
     at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS access_log_at_idx ON access_log (at)`,
];

export async function applySchema(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
