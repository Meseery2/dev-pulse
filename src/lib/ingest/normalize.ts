import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  commits as commitsTable,
  contributors as contributorsTable,
  deploymentCommits as deploymentCommitsTable,
  deployments as deploymentsTable,
  incidents as incidentsTable,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  squads as squadsTable,
} from "../db/schema";
import { sourcesConfig, squadForRepo } from "../config/sources";
import type {
  RawCommitRecord,
  RawPullRecord,
  RawReviewCommentRecord,
  RawWorkflowRunRecord,
} from "../connectors/github/project";
import { readRawEvents } from "./raw-store";
import {
  deriveIncidents,
  joinDeploymentCommits,
  normalizeCommits,
  normalizeDeployments,
  normalizePullRequests,
  type CommitRow,
  type DeploymentRow,
} from "./normalize-core";
import { stableId } from "../util/identity";

/** Squads and repositories come from config, so they are reconciled on every run. */
export async function syncConfigEntities(): Promise<void> {
  for (const squad of sourcesConfig.squads) {
    await db
      .insert(squadsTable)
      .values({ id: squad.id, name: squad.name, description: squad.description })
      .onConflictDoUpdate({
        target: squadsTable.id,
        set: { name: sql`excluded.name`, description: sql`excluded.description` },
      });
  }

  for (const repo of sourcesConfig.repos) {
    await db
      .insert(repositoriesTable)
      .values({
        slug: repo.slug,
        squadId: squadForRepo(repo.slug)?.id ?? null,
        defaultBranch: repo.defaultBranch,
        isSeeded: repo.provenance === "seeded",
      })
      .onConflictDoUpdate({
        target: repositoriesTable.slug,
        set: {
          squadId: sql`excluded.squad_id`,
          defaultBranch: sql`excluded.default_branch`,
          isSeeded: sql`excluded.is_seeded`,
        },
      });
  }
}

async function upsertContributors(
  entries: { identityHash: string | null; isBot: boolean }[],
): Promise<Map<string, string>> {
  const unique = new Map<string, boolean>();
  for (const entry of entries) {
    if (!entry.identityHash) continue;
    unique.set(entry.identityHash, entry.isBot || (unique.get(entry.identityHash) ?? false));
  }
  if (unique.size === 0) return new Map();

  const rows = [...unique.entries()].map(([identityHash, isBot]) => ({
    id: stableId("contributor", identityHash),
    identityHash,
    isBot,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(contributorsTable)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: contributorsTable.identityHash,
        set: { isBot: sql`excluded.is_bot` },
      });
  }

  return new Map(rows.map((row) => [row.identityHash, row.id]));
}

export interface NormalizeResult {
  commits: number;
  pullRequests: number;
  deployments: number;
  deploymentCommits: number;
  incidents: number;
}

export async function normalizeGitHub(): Promise<NormalizeResult> {
  await syncConfigEntities();

  const result: NormalizeResult = {
    commits: 0,
    pullRequests: 0,
    deployments: 0,
    deploymentCommits: 0,
    incidents: 0,
  };

  for (const repo of sourcesConfig.repos) {
    if (repo.provenance !== "live") continue;
    const slug = repo.slug;

    const rawCommits = await readRawEvents<RawCommitRecord>("github", "commit", slug);
    const rawPulls = await readRawEvents<RawPullRecord>("github", "pull_request", slug);
    const rawDetails = await readRawEvents<RawPullRecord>("github", "pull_request_detail", slug);
    const rawComments = await readRawEvents<RawReviewCommentRecord>("github", "review_comment", slug);
    const rawRuns = await readRawEvents<RawWorkflowRunRecord>("github", "workflow_run", slug);

    const commitRows = normalizeCommits(rawCommits, slug);
    const prRows = normalizePullRequests(rawPulls, rawDetails, rawComments, slug);
    const deploymentRows = normalizeDeployments(rawRuns, repo);
    const deploymentCommitRows = joinDeploymentCommits(deploymentRows, commitRows);
    const incidentRows = deriveIncidents(deploymentRows, commitRows, deploymentCommitRows);

    const contributorIds = await upsertContributors([...commitRows, ...prRows]);

    await persistCommits(commitRows, contributorIds);
    await persistPullRequests(prRows, contributorIds);
    await persistDeployments(deploymentRows);
    await persistDeploymentCommits(deploymentCommitRows);
    await persistIncidents(incidentRows);

    result.commits += commitRows.length;
    result.pullRequests += prRows.length;
    result.deployments += deploymentRows.length;
    result.deploymentCommits += deploymentCommitRows.length;
    result.incidents += incidentRows.length;
  }

  return result;
}

async function persistCommits(rows: CommitRow[], contributorIds: Map<string, string>) {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(commitsTable)
      .values(
        rows.slice(i, i + CHUNK).map((row) => ({
          sha: row.sha,
          repoSlug: row.repoSlug,
          contributorId: row.identityHash ? (contributorIds.get(row.identityHash) ?? null) : null,
          authoredAt: row.authoredAt,
          committedAt: row.committedAt,
          branchPosition: row.branchPosition,
          isRevert: row.isRevert,
          revertsSha: row.revertsSha,
          isMerge: row.isMerge,
          isSeeded: false,
        })),
      )
      .onConflictDoUpdate({
        target: [commitsTable.repoSlug, commitsTable.sha],
        set: {
          branchPosition: sql`excluded.branch_position`,
          isRevert: sql`excluded.is_revert`,
          revertsSha: sql`excluded.reverts_sha`,
        },
      });
  }
}

async function persistPullRequests(
  rows: ReturnType<typeof normalizePullRequests>,
  contributorIds: Map<string, string>,
) {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(pullRequestsTable)
      .values(
        rows.slice(i, i + CHUNK).map((row) => ({
          id: row.id,
          repoSlug: row.repoSlug,
          number: row.number,
          authorId: row.identityHash ? (contributorIds.get(row.identityHash) ?? null) : null,
          openedAt: row.openedAt,
          readyAt: row.readyAt,
          firstReviewAt: row.firstReviewAt,
          mergedAt: row.mergedAt,
          closedAt: row.closedAt,
          mergeCommitSha: row.mergeCommitSha,
          additions: row.additions,
          deletions: row.deletions,
          changedFiles: row.changedFiles,
          isDraft: row.isDraft,
          isSeeded: false,
        })),
      )
      .onConflictDoUpdate({
        target: [pullRequestsTable.repoSlug, pullRequestsTable.number],
        set: {
          firstReviewAt: sql`excluded.first_review_at`,
          mergedAt: sql`excluded.merged_at`,
          closedAt: sql`excluded.closed_at`,
          additions: sql`coalesce(excluded.additions, pull_requests.additions)`,
          deletions: sql`coalesce(excluded.deletions, pull_requests.deletions)`,
          changedFiles: sql`coalesce(excluded.changed_files, pull_requests.changed_files)`,
          isDraft: sql`excluded.is_draft`,
        },
      });
  }
}

async function persistDeployments(rows: DeploymentRow[]) {
  if (rows.length === 0) return;
  await db
    .insert(deploymentsTable)
    .values(rows.map((row) => ({ ...row, isSeeded: false })))
    .onConflictDoUpdate({
      target: deploymentsTable.id,
      set: { status: sql`excluded.status`, finishedAt: sql`excluded.finished_at` },
    });
}

async function persistDeploymentCommits(rows: { deploymentId: string; repoSlug: string; sha: string }[]) {
  if (rows.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(deploymentCommitsTable).values(rows.slice(i, i + CHUNK)).onConflictDoNothing();
  }
}

async function persistIncidents(rows: ReturnType<typeof deriveIncidents>) {
  if (rows.length === 0) return;
  await db
    .insert(incidentsTable)
    .values(rows.map((row) => ({ ...row, isSeeded: false })))
    .onConflictDoUpdate({
      target: incidentsTable.id,
      set: { resolvedAt: sql`excluded.resolved_at` },
    });
}
