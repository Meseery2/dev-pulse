import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { syncRuns, syncState } from "../db/schema";
import { liveRepos, type RepoConfig } from "../config/sources";
import {
  BudgetExhaustedError,
  GitHubClient,
  RateLimitError,
  RequestBudget,
} from "../connectors/github/client";
import {
  fetchCommits,
  fetchPullRequestDetail,
  fetchPullRequests,
  fetchReviewComments,
  fetchWorkflowRuns,
  type GhPullRequest,
} from "../connectors/github/resources";
import { writeRawEvents, type RawRecord } from "./raw-store";
import { stableId } from "../util/identity";

export interface SyncOptions {
  /** Hard cap on API calls for this run. Defaults to the unauthenticated ceiling. */
  budget?: number;
  /** How far back to look on a cold start. */
  lookbackDays?: number;
  /** Spend leftover budget enriching pull requests with size data. */
  enrich?: boolean;
  client?: GitHubClient;
}

export interface SyncResult {
  status: "success" | "partial" | "failed";
  requestsUsed: number;
  rowsWritten: number;
  rateLimited: boolean;
  repos: { slug: string; rows: number; error?: string }[];
  message: string;
}

const SOURCE_GITHUB = "github";

async function getWatermark(resource: string, repoSlug: string) {
  const [row] = await db
    .select()
    .from(syncState)
    .where(
      sql`${syncState.source} = ${SOURCE_GITHUB} AND ${syncState.resource} = ${resource} AND ${syncState.repoSlug} = ${repoSlug}`,
    )
    .limit(1);
  return row ?? null;
}

async function setWatermark(resource: string, repoSlug: string, etag: string | null) {
  const id = stableId(SOURCE_GITHUB, resource, repoSlug);
  await db
    .insert(syncState)
    .values({
      id,
      source: SOURCE_GITHUB,
      resource,
      repoSlug,
      etag,
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [syncState.source, syncState.resource, syncState.repoSlug],
      set: { etag: sql`excluded.etag`, lastSyncedAt: sql`excluded.last_synced_at` },
    });
}

async function syncRepo(
  client: GitHubClient,
  repo: RepoConfig,
  lookback: Date,
  enrich: boolean,
): Promise<number> {
  const records: RawRecord[] = [];
  const slug = repo.slug;

  const commitState = await getWatermark("commits", slug);
  const commits = await fetchCommits(client, slug, repo.defaultBranch, {
    maxPages: 2,
    since: lookback,
    etag: commitState?.etag,
  });
  if (!commits.notModified) {
    // branch_position is assigned here because the list endpoint returns the
    // default branch in topological order; it is what lets the deployment /
    // commit join run locally instead of costing one compare call per deploy.
    commits.items.forEach((commit, index) => {
      records.push({
        source: SOURCE_GITHUB,
        kind: "commit",
        externalId: `${slug}#${commit.sha}`,
        repoSlug: slug,
        payload: { ...commit, __branchPosition: index, __repoSlug: slug },
        occurredAt: commit.commit.author?.date ? new Date(commit.commit.author.date) : null,
      });
    });
    await setWatermark("commits", slug, commits.etag);
  }

  const runState = await getWatermark("workflow_runs", slug);
  const runs = await fetchWorkflowRuns(client, slug, {
    maxPages: 2,
    createdSince: lookback,
    etag: runState?.etag,
  });
  if (!runs.notModified) {
    for (const run of runs.items) {
      records.push({
        source: SOURCE_GITHUB,
        kind: "workflow_run",
        externalId: `${slug}#${run.id}`,
        repoSlug: slug,
        payload: { ...run, __repoSlug: slug },
        occurredAt: new Date(run.updated_at),
      });
    }
    await setWatermark("workflow_runs", slug, runs.etag);
  }

  const prState = await getWatermark("pulls", slug);
  const pulls = await fetchPullRequests(client, slug, {
    maxPages: 2,
    updatedSince: lookback,
    etag: prState?.etag,
  });
  if (!pulls.notModified) {
    for (const pr of pulls.items) {
      records.push({
        source: SOURCE_GITHUB,
        kind: "pull_request",
        externalId: `${slug}#${pr.number}`,
        repoSlug: slug,
        payload: { ...pr, __repoSlug: slug },
        occurredAt: new Date(pr.updated_at),
      });
    }
    await setWatermark("pulls", slug, pulls.etag);
  }

  const commentState = await getWatermark("review_comments", slug);
  const comments = await fetchReviewComments(client, slug, {
    maxPages: 2,
    since: lookback,
    etag: commentState?.etag,
  });
  if (!comments.notModified) {
    for (const comment of comments.items) {
      records.push({
        source: SOURCE_GITHUB,
        kind: "review_comment",
        externalId: `${slug}#${comment.id}`,
        repoSlug: slug,
        payload: { ...comment, __repoSlug: slug },
        occurredAt: new Date(comment.created_at),
      });
    }
    await setWatermark("review_comments", slug, comments.etag);
  }

  // Pull request size is only available on the per-PR endpoint. Rather than
  // make it a hard requirement, leftover budget is spent on the most recently
  // merged PRs and the metric reports its own sample size.
  if (enrich) {
    const mergedRecent = pulls.items
      .filter((pr) => pr.merged_at)
      .sort((a, b) => new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime());
    const reserve = 4;
    for (const pr of mergedRecent) {
      if (client.budget.remaining <= reserve) break;
      try {
        const detail: GhPullRequest = await fetchPullRequestDetail(client, slug, pr.number);
        records.push({
          source: SOURCE_GITHUB,
          kind: "pull_request_detail",
          externalId: `${slug}#${pr.number}`,
          repoSlug: slug,
          payload: { ...detail, __repoSlug: slug },
          occurredAt: new Date(detail.updated_at),
        });
      } catch {
        break;
      }
    }
  }

  return writeRawEvents(records);
}

export async function runGitHubSync(options: SyncOptions = {}): Promise<SyncResult> {
  const token = process.env.GITHUB_TOKEN?.trim() || undefined;
  const defaultBudget = token ? 400 : 50;
  const budget = new RequestBudget(options.budget ?? defaultBudget);
  const client = options.client ?? new GitHubClient({ token, budget });
  const lookbackDays = options.lookbackDays ?? 90;
  const lookback = new Date(Date.now() - lookbackDays * 86_400_000);

  const runId = stableId("sync", SOURCE_GITHUB, Date.now());
  await db.insert(syncRuns).values({ id: runId, source: SOURCE_GITHUB, status: "running" });

  const repos = liveRepos();
  const perRepo: SyncResult["repos"] = [];
  let rowsWritten = 0;
  let rateLimited = false;

  for (const repo of repos) {
    try {
      const rows = await syncRepo(client, repo, lookback, options.enrich ?? true);
      rowsWritten += rows;
      perRepo.push({ slug: repo.slug, rows });
    } catch (error) {
      // One source failing must not block the others, and a rate-limit stop is
      // an expected outcome rather than an error condition.
      if (error instanceof RateLimitError || error instanceof BudgetExhaustedError) {
        rateLimited = true;
        perRepo.push({ slug: repo.slug, rows: 0, error: error.message });
        break;
      }
      perRepo.push({
        slug: repo.slug,
        rows: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failures = perRepo.filter((r) => r.error).length;
  const status: SyncResult["status"] =
    failures === 0 ? "success" : failures === repos.length ? "failed" : "partial";
  const message = rateLimited
    ? `Stopped early on API budget after ${client.budget.used} requests; existing data is still served and the next run resumes from the watermark.`
    : `Synced ${repos.length - failures}/${repos.length} repositories using ${client.budget.used} requests.`;

  await db
    .update(syncRuns)
    .set({
      status,
      finishedAt: new Date(),
      requestsUsed: client.budget.used,
      rowsWritten,
      rateLimited,
      message,
    })
    .where(eq(syncRuns.id, runId));

  return {
    status,
    requestsUsed: client.budget.used,
    rowsWritten,
    rateLimited,
    repos: perRepo,
    message,
  };
}
