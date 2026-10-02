import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  commits as commitsTable,
  contributors as contributorsTable,
  deploymentCommits as deploymentCommitsTable,
  deployments as deploymentsTable,
  incidents as incidentsTable,
  pullRequests as pullRequestsTable,
  workItems as workItemsTable,
} from "../db/schema";
import { seededRepos, sourcesConfig } from "../config/sources";
import { hashIdentity, stableId } from "../util/identity";
import { Random } from "./rng";

const SEED = 20261002;
const HORIZON_DAYS = 140;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Deploys cluster on weekdays; Saturday and Sunday are deliberately quiet. */
function weekdayWeight(date: Date): number {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return 0.12;
  if (day === 5) return 0.75;
  return 1;
}

interface SeededCommit {
  sha: string;
  repoSlug: string;
  contributorId: string;
  authoredAt: Date;
  branchPosition: number;
}

export interface SeedSummary {
  contributors: number;
  commits: number;
  pullRequests: number;
  deployments: number;
  incidents: number;
  workItems: number;
}

export async function generateSyntheticData(now = new Date()): Promise<SeedSummary> {
  const random = new Random(SEED);
  const repos = seededRepos();
  const summary: SeedSummary = {
    contributors: 0,
    commits: 0,
    pullRequests: 0,
    deployments: 0,
    incidents: 0,
    workItems: 0,
  };

  // Synthetic contributors are hashed exactly like real ones, so the seeded
  // path exercises the same pseudonymisation the live path uses.
  const logins = Array.from({ length: 11 }, (_, i) => `mal-engineer-${i + 1}`);
  const contributorRows = logins.map((login) => ({
    id: stableId("contributor", hashIdentity(login)),
    identityHash: hashIdentity(login),
    isBot: false,
  }));
  await db
    .insert(contributorsTable)
    .values(contributorRows)
    .onConflictDoUpdate({ target: contributorsTable.identityHash, set: { isBot: sql`excluded.is_bot` } });
  summary.contributors = contributorRows.length;

  const start = new Date(now.getTime() - HORIZON_DAYS * DAY_MS);

  for (const repo of repos) {
    const slug = repo.slug;
    const commits: SeededCommit[] = [];

    // Commits first, newest-last; branch positions are assigned afterwards so
    // they match the newest-is-zero convention used by the live connector.
    let cursor = start.getTime();
    while (cursor < now.getTime()) {
      const date = new Date(cursor);
      const perDay = random.float(1.5, 6) * weekdayWeight(date);
      const count = Math.max(0, Math.round(perDay));
      for (let i = 0; i < count; i += 1) {
        const authoredAt = new Date(cursor + random.float(8, 19) * HOUR_MS);
        if (authoredAt > now) continue;
        commits.push({
          sha: stableId("seed-commit", slug, authoredAt.toISOString(), i).slice(0, 40),
          repoSlug: slug,
          contributorId: random.pick(contributorRows).id,
          authoredAt,
          branchPosition: 0,
        });
      }
      cursor += DAY_MS;
    }

    commits.sort((a, b) => b.authoredAt.getTime() - a.authoredAt.getTime());
    commits.forEach((commit, index) => {
      commit.branchPosition = index;
    });

    const chronological = [...commits].sort(
      (a, b) => a.authoredAt.getTime() - b.authoredAt.getTime(),
    );

    const deployRows: (typeof deploymentsTable.$inferInsert)[] = [];
    const deployCommitRows: (typeof deploymentCommitsTable.$inferInsert)[] = [];
    const incidentRows: (typeof incidentsTable.$inferInsert)[] = [];

    let index = 0;
    let deployTime = start.getTime() + random.float(4, 20) * HOUR_MS;
    let lastSuccessful: { id: string; finishedAt: Date } | null = null;

    while (deployTime < now.getTime()) {
      const at = new Date(deployTime);
      const included: SeededCommit[] = [];
      while (index < chronological.length && chronological[index].authoredAt.getTime() <= deployTime) {
        included.push(chronological[index]);
        index += 1;
      }

      if (included.length > 0) {
        const failed = random.bool(0.11);
        const startedAt = at;
        const finishedAt = new Date(at.getTime() + random.float(3, 14) * 60_000);
        const id = stableId("seed-deploy", slug, at.toISOString());

        deployRows.push({
          id,
          repoSlug: slug,
          environment: "production",
          status: failed ? "failure" : "success",
          headSha: included[included.length - 1].sha,
          workflowName: "deploy-production",
          startedAt,
          finishedAt,
          isSeeded: true,
        });

        if (!failed) {
          for (const commit of included) {
            deployCommitRows.push({ deploymentId: id, repoSlug: slug, sha: commit.sha });
          }
          lastSuccessful = { id, finishedAt };
        } else {
          // Recovery follows a log-normal: most failures are fixed inside an
          // hour, a few drag on much longer.
          const recoveryHours = Math.min(72, random.logNormal(0.8, 1.1));
          incidentRows.push({
            id: stableId("seed-incident", id),
            repoSlug: slug,
            deploymentId: id,
            origin: "failed_deploy",
            startedAt: finishedAt,
            resolvedAt: new Date(finishedAt.getTime() + recoveryHours * HOUR_MS),
            isSeeded: true,
          });
        }
      }

      deployTime += random.float(0.4, 2.2) * DAY_MS;
    }

    // A small number of changes deploy cleanly and fail in production later.
    for (const deployment of deployRows) {
      if (deployment.status !== "success") continue;
      if (!random.bool(0.045)) continue;
      const startedAt = new Date(deployment.finishedAt.getTime() + random.float(0.5, 8) * HOUR_MS);
      if (startedAt > now) continue;
      incidentRows.push({
        id: stableId("seed-incident-revert", deployment.id),
        repoSlug: slug,
        deploymentId: deployment.id,
        origin: "revert",
        startedAt,
        resolvedAt: new Date(startedAt.getTime() + Math.min(48, random.logNormal(2.5, 0.9)) * HOUR_MS),
        isSeeded: true,
      });
    }

    const prRows: (typeof pullRequestsTable.$inferInsert)[] = [];
    let prNumber = 100;
    for (let i = 0; i < chronological.length; i += random.int(2, 4)) {
      const base = chronological[i];
      const openedAt = new Date(base.authoredAt.getTime() - random.float(2, 40) * HOUR_MS);
      if (openedAt < start) continue;
      const reviewWaitHours = random.logNormal(5, 1.0);
      const firstReviewAt = new Date(openedAt.getTime() + reviewWaitHours * HOUR_MS);
      const mergedAt = new Date(firstReviewAt.getTime() + random.logNormal(6, 1.0) * HOUR_MS);
      const additions = Math.round(random.logNormal(90, 1.1));
      prNumber += 1;

      prRows.push({
        id: stableId("seed-pr", slug, prNumber),
        repoSlug: slug,
        number: prNumber,
        authorId: base.contributorId,
        openedAt,
        readyAt: openedAt,
        firstReviewAt: firstReviewAt < now ? firstReviewAt : null,
        mergedAt: mergedAt < now ? mergedAt : null,
        closedAt: mergedAt < now ? mergedAt : null,
        mergeCommitSha: base.sha,
        additions,
        deletions: Math.round(additions * random.float(0.1, 0.7)),
        changedFiles: Math.max(1, Math.round(additions / random.float(20, 60))),
        isDraft: false,
        isSeeded: true,
      });
    }

    await insertChunked(commitsTable, commits.map((commit) => ({
      sha: commit.sha,
      repoSlug: commit.repoSlug,
      contributorId: commit.contributorId,
      authoredAt: commit.authoredAt,
      committedAt: commit.authoredAt,
      branchPosition: commit.branchPosition,
      isRevert: false,
      revertsSha: null,
      isMerge: false,
      isSeeded: true,
    })));
    if (deployRows.length) {
      await insertChunked(deploymentsTable, deployRows);
      await insertChunked(deploymentCommitsTable, deployCommitRows);
    }
    if (incidentRows.length) await insertChunked(incidentsTable, incidentRows);
    if (prRows.length) await insertChunked(pullRequestsTable, prRows);

    summary.commits += commits.length;
    summary.deployments += deployRows.length;
    summary.incidents += incidentRows.length;
    summary.pullRequests += prRows.length;
    void lastSuccessful;
  }

  summary.workItems = await generateWorkItems(random, now);
  return summary;
}

/**
 * Project-management items for every squad, including the two backed by live
 * repositories. Flow efficiency and unplanned work are the only metrics that
 * depend on them, and both are labelled as seeded throughout the UI.
 */
async function generateWorkItems(random: Random, now: Date): Promise<number> {
  const rows: (typeof workItemsTable.$inferInsert)[] = [];
  const start = new Date(now.getTime() - HORIZON_DAYS * DAY_MS);

  for (const squad of sourcesConfig.squads) {
    let cursor = start.getTime();
    let counter = 0;
    // Each squad gets a slightly different unplanned-work mix so the exec view
    // has something real to compare.
    const bugWeight = 1 + (squad.id.charCodeAt(0) % 3) * 0.6;

    while (cursor < now.getTime()) {
      const perDay = random.float(0.8, 3.4) * weekdayWeight(new Date(cursor));
      for (let i = 0; i < Math.round(perDay); i += 1) {
        const createdAt = new Date(cursor + random.float(0, 24) * HOUR_MS);
        if (createdAt > now) continue;
        counter += 1;

        const type = random.weighted([
          ["feature", 5],
          ["bug", bugWeight * 2],
          ["maintenance", 2],
          ["incident", bugWeight * 0.4],
        ] as const);

        const waitHours = random.logNormal(26, 1.1);
        const activeHours = random.logNormal(9, 0.8);
        const startedAt = new Date(createdAt.getTime() + waitHours * HOUR_MS);
        const completedAt = new Date(startedAt.getTime() + activeHours * HOUR_MS);
        const done = completedAt < now;

        rows.push({
          id: stableId("seed-work", squad.id, counter),
          source: "linear-synthetic",
          externalKey: `${squad.id.slice(0, 3).toUpperCase()}-${counter}`,
          squadId: squad.id,
          type,
          state: done ? "done" : startedAt < now ? "in_progress" : "todo",
          createdAt,
          startedAt: startedAt < now ? startedAt : null,
          completedAt: done ? completedAt : null,
          activeSeconds: done ? Math.round(activeHours * 3600) : null,
          isSeeded: true,
        });
      }
      cursor += DAY_MS;
    }
  }

  await insertChunked(workItemsTable, rows);
  return rows.length;
}

async function insertChunked<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  rows: T[],
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(table).values(rows.slice(i, i + chunk)).onConflictDoNothing();
  }
}
