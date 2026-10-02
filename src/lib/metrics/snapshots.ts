import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  commits as commitsTable,
  contributors as contributorsTable,
  deploymentCommits as deploymentCommitsTable,
  deployments as deploymentsTable,
  incidents as incidentsTable,
  metricSnapshots,
  pullRequests as pullRequestsTable,
  workItems as workItemsTable,
} from "../db/schema";
import { sourcesConfig } from "../config/sources";
import { DEFINITION_VERSION, METRICS, type MetricKey } from "./definitions";
import {
  computeAll,
  filterDatasetToRepos,
  filterWorkItemsToSquads,
  type MetricDataset,
  type Window,
} from "./compute";
import { stableId } from "../util/identity";

export const DEFAULT_WINDOW_DAYS = 28;
export const TREND_POINTS = 12;
const TREND_STEP_DAYS = 7;

export async function loadDataset(): Promise<MetricDataset> {
  const [deployRows, commitRows, prRows, incidentRows, workItemRows, deployCommitRows, botRows] =
    await Promise.all([
      db
        .select({
          id: deploymentsTable.id,
          repoSlug: deploymentsTable.repoSlug,
          status: deploymentsTable.status,
          finishedAt: deploymentsTable.finishedAt,
          isSeeded: deploymentsTable.isSeeded,
        })
        .from(deploymentsTable),
      db
        .select({
          sha: commitsTable.sha,
          repoSlug: commitsTable.repoSlug,
          authoredAt: commitsTable.authoredAt,
          contributorId: commitsTable.contributorId,
          isSeeded: commitsTable.isSeeded,
        })
        .from(commitsTable),
      db
        .select({
          repoSlug: pullRequestsTable.repoSlug,
          authorId: pullRequestsTable.authorId,
          openedAt: pullRequestsTable.openedAt,
          firstReviewAt: pullRequestsTable.firstReviewAt,
          mergedAt: pullRequestsTable.mergedAt,
          additions: pullRequestsTable.additions,
          deletions: pullRequestsTable.deletions,
          isSeeded: pullRequestsTable.isSeeded,
        })
        .from(pullRequestsTable),
      db
        .select({
          repoSlug: incidentsTable.repoSlug,
          deploymentId: incidentsTable.deploymentId,
          startedAt: incidentsTable.startedAt,
          resolvedAt: incidentsTable.resolvedAt,
          isSeeded: incidentsTable.isSeeded,
        })
        .from(incidentsTable),
      db
        .select({
          squadId: workItemsTable.squadId,
          type: workItemsTable.type,
          createdAt: workItemsTable.createdAt,
          completedAt: workItemsTable.completedAt,
          activeSeconds: workItemsTable.activeSeconds,
          isSeeded: workItemsTable.isSeeded,
        })
        .from(workItemsTable),
      db
        .select({
          deploymentId: deploymentCommitsTable.deploymentId,
          sha: deploymentCommitsTable.sha,
        })
        .from(deploymentCommitsTable),
      db
        .select({ id: contributorsTable.id, isBot: contributorsTable.isBot })
        .from(contributorsTable),
    ]);

  const botById = new Map(botRows.map((row) => [row.id, row.isBot]));
  const deploymentCommits = new Map<string, string[]>();
  for (const row of deployCommitRows) {
    const list = deploymentCommits.get(row.deploymentId) ?? [];
    list.push(row.sha);
    deploymentCommits.set(row.deploymentId, list);
  }

  return {
    deployments: deployRows.map((row) => ({
      id: row.id,
      repoSlug: row.repoSlug,
      status: row.status as "success" | "failure",
      finishedAt: row.finishedAt,
      isSeeded: row.isSeeded,
    })),
    deploymentCommits,
    commits: commitRows.map((row) => ({
      sha: row.sha,
      repoSlug: row.repoSlug,
      authoredAt: row.authoredAt,
      contributorId: row.contributorId,
      isBot: row.contributorId ? (botById.get(row.contributorId) ?? false) : false,
      isSeeded: row.isSeeded,
    })),
    pullRequests: prRows.map((row) => ({
      repoSlug: row.repoSlug,
      authorId: row.authorId,
      isBot: row.authorId ? (botById.get(row.authorId) ?? false) : false,
      openedAt: row.openedAt,
      firstReviewAt: row.firstReviewAt,
      mergedAt: row.mergedAt,
      additions: row.additions,
      deletions: row.deletions,
      isSeeded: row.isSeeded,
    })),
    incidents: incidentRows,
    workItems: workItemRows,
  };
}

interface Scope {
  type: "org" | "squad" | "repo";
  id: string;
  repoSlugs: string[];
  squadIds: string[];
}

function buildScopes(): Scope[] {
  const scopes: Scope[] = [
    {
      type: "org",
      id: "org",
      repoSlugs: sourcesConfig.repos.map((r) => r.slug),
      squadIds: sourcesConfig.squads.map((s) => s.id),
    },
  ];
  for (const squad of sourcesConfig.squads) {
    scopes.push({ type: "squad", id: squad.id, repoSlugs: squad.repos, squadIds: [squad.id] });
  }
  for (const repo of sourcesConfig.repos) {
    scopes.push({ type: "repo", id: repo.slug, repoSlugs: [repo.slug], squadIds: [] });
  }
  return scopes;
}

export interface MaterializeResult {
  rows: number;
  scopes: number;
  periods: number;
}

/**
 * Recomputes every scope across a rolling trend series. Snapshots are keyed by
 * (metric, scope, periodEnd, window) and upserted, so a recompute replaces a
 * value in place and a definition change is visible through
 * `definition_version` rather than silently rewriting history.
 */
export async function materializeSnapshots(options: { now?: Date } = {}): Promise<MaterializeResult> {
  const dataset = await loadDataset();
  const now = options.now ?? new Date();
  const scopes = buildScopes();

  const periodEnds: Date[] = [];
  for (let i = TREND_POINTS - 1; i >= 0; i -= 1) {
    periodEnds.push(new Date(now.getTime() - i * TREND_STEP_DAYS * 86_400_000));
  }

  const rows: (typeof metricSnapshots.$inferInsert)[] = [];

  for (const scope of scopes) {
    let scoped = filterDatasetToRepos(dataset, scope.repoSlugs);
    scoped = filterWorkItemsToSquads(scoped, scope.squadIds);

    for (const periodEnd of periodEnds) {
      const window: Window = {
        start: new Date(periodEnd.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000),
        end: periodEnd,
      };
      const values = computeAll(scoped, window);

      for (const [key, value] of Object.entries(values) as [MetricKey, (typeof values)[MetricKey]][]) {
        rows.push({
          id: stableId("snapshot", key, scope.type, scope.id, periodEnd.toISOString(), DEFAULT_WINDOW_DAYS),
          metricKey: key,
          scopeType: scope.type,
          scopeId: scope.id,
          periodStart: window.start,
          periodEnd: window.end,
          windowDays: DEFAULT_WINDOW_DAYS,
          value: value.value === null ? null : String(value.value),
          secondaryValue: value.secondaryValue === null ? null : String(value.secondaryValue),
          numerator: value.numerator === null ? null : String(value.numerator),
          denominator: value.denominator === null ? null : String(value.denominator),
          sampleSize: value.sampleSize,
          contributorCount: value.contributorCount,
          definitionVersion: DEFINITION_VERSION,
          isSeeded: value.hasSeededInputs && METRICS[key] !== undefined && isFullySeeded(scope),
          hasSeededInputs: value.hasSeededInputs,
          computedAt: new Date(),
        });
      }
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(metricSnapshots)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          metricSnapshots.metricKey,
          metricSnapshots.scopeType,
          metricSnapshots.scopeId,
          metricSnapshots.periodEnd,
          metricSnapshots.windowDays,
        ],
        set: {
          value: sql`excluded.value`,
          secondaryValue: sql`excluded.secondary_value`,
          numerator: sql`excluded.numerator`,
          denominator: sql`excluded.denominator`,
          sampleSize: sql`excluded.sample_size`,
          contributorCount: sql`excluded.contributor_count`,
          definitionVersion: sql`excluded.definition_version`,
          isSeeded: sql`excluded.is_seeded`,
          hasSeededInputs: sql`excluded.has_seeded_inputs`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  return { rows: rows.length, scopes: scopes.length, periods: periodEnds.length };
}

function isFullySeeded(scope: Scope): boolean {
  if (scope.repoSlugs.length === 0) return false;
  return scope.repoSlugs.every(
    (slug) => sourcesConfig.repos.find((r) => r.slug === slug)?.provenance === "seeded",
  );
}
