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
import {
  projectCommit,
  projectPullRequest,
  projectReviewComment,
  projectWorkflowRun,
} from "../connectors/github/project";
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
  repos: { slug: string; rows: number; truncated?: boolean; error?: string }[];
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

/** Worst-case requests a single repository needs for its core resources. */
const CORE_REQUESTS_PER_REPO = 8;

interface RepoSyncOutcome {
  rows: number;
  truncated: boolean;
  mergedPullNumbers: number[];
}

async function syncRepo(
  client: GitHubClient,
  repo: RepoConfig,
  lookback: Date,
): Promise<RepoSyncOutcome> {
  const records: RawRecord[] = [];
  const slug = repo.slug;
  let truncated = false;
  // Watermarks are collected here and only committed after the rows they
  // describe are durably written. Advancing a watermark first would make the
  // next run receive a 304 and skip data that was never actually stored.
  const pendingWatermarks: { resource: string; etag: string | null }[] = [];

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
      const projected = projectCommit(commit, index);
      if (!projected) return;
      records.push({
        source: SOURCE_GITHUB,
        kind: "commit",
        externalId: `${slug}#${projected.sha}`,
        repoSlug: slug,
        payload: projected,
        occurredAt: new Date(projected.authoredAt),
      });
    });
    pendingWatermarks.push({ resource: "commits", etag: commits.etag });
  }

  const runState = await getWatermark("workflow_runs", slug);
  const runs = await fetchWorkflowRuns(client, slug, {
    maxPages: 2,
    createdSince: lookback,
    etag: runState?.etag,
  });
  if (!runs.notModified) {
    for (const run of runs.items) {
      const projected = projectWorkflowRun(run);
      if (!projected) continue;
      records.push({
        source: SOURCE_GITHUB,
        kind: "workflow_run",
        externalId: `${slug}#${projected.id}`,
        repoSlug: slug,
        payload: projected,
        occurredAt: new Date(projected.updatedAt),
      });
    }
    pendingWatermarks.push({ resource: "workflow_runs", etag: runs.etag });
  }

  const prState = await getWatermark("pulls", slug);
  const pulls = await fetchPullRequests(client, slug, {
    maxPages: 2,
    updatedSince: lookback,
    etag: prState?.etag,
  });
  if (!pulls.notModified) {
    for (const pr of pulls.items) {
      const projected = projectPullRequest(pr);
      if (!projected) continue;
      records.push({
        source: SOURCE_GITHUB,
        kind: "pull_request",
        externalId: `${slug}#${projected.number}`,
        repoSlug: slug,
        payload: projected,
        occurredAt: new Date(projected.updatedAt),
      });
    }
    pendingWatermarks.push({ resource: "pulls", etag: pulls.etag });
  }

  const commentState = await getWatermark("review_comments", slug);
  const comments = await fetchReviewComments(client, slug, {
    maxPages: 2,
    since: lookback,
    etag: commentState?.etag,
  });
  if (!comments.notModified) {
    for (const comment of comments.items) {
      const projected = projectReviewComment(comment);
      if (!projected) continue;
      records.push({
        source: SOURCE_GITHUB,
        kind: "review_comment",
        externalId: `${slug}#${projected.id}`,
        repoSlug: slug,
        payload: projected,
        occurredAt: new Date(projected.createdAt),
      });
    }
    pendingWatermarks.push({ resource: "review_comments", etag: comments.etag });
  }

  truncated =
    commits.truncated || runs.truncated || pulls.truncated || comments.truncated;

  const mergedPullNumbers = pulls.items
    .filter((pr) => pr.merged_at)
    .sort((a, b) => new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime())
    .map((pr) => pr.number);

  const rows = await writeRawEvents(records);
  for (const watermark of pendingWatermarks) {
    await setWatermark(watermark.resource, slug, watermark.etag);
  }
  return { rows, truncated, mergedPullNumbers };
}

/**
 * Pull request size is only available on the per-pull-request endpoint, so it
 * is enriched after every repository has had its core resources fetched.
 * Running it inline would let the first repository spend the whole budget and
 * leave later repositories with no data at all.
 *
 * Repositories are visited round-robin so a partial budget produces an even
 * sample rather than a complete picture of one repository and nothing of the
 * others.
 */
async function enrichPullRequests(
  client: GitHubClient,
  pending: { slug: string; numbers: number[] }[],
): Promise<number> {
  const records: RawRecord[] = [];
  const queues = pending.map((entry) => ({ slug: entry.slug, numbers: [...entry.numbers] }));
  let exhausted = false;

  while (!exhausted && client.budget.remaining > 0) {
    let progressed = false;
    for (const queue of queues) {
      if (client.budget.remaining <= 0) break;
      const number = queue.numbers.shift();
      if (number === undefined) continue;
      progressed = true;
      try {
        const detail: GhPullRequest = await fetchPullRequestDetail(client, queue.slug, number);
        const projected = projectPullRequest(detail);
        if (projected) {
          records.push({
            source: SOURCE_GITHUB,
            kind: "pull_request_detail",
            externalId: `${queue.slug}#${number}`,
            repoSlug: queue.slug,
            payload: projected,
            occurredAt: new Date(projected.updatedAt),
          });
        }
      } catch {
        exhausted = true;
        break;
      }
    }
    if (!progressed) break;
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
  const enrichQueue: { slug: string; numbers: number[] }[] = [];
  let rowsWritten = 0;
  let rateLimited = false;

  for (const repo of repos) {
    // Stopping before a repository that cannot be fetched completely is
    // preferable to fetching it partially and silently reporting metrics from
    // a fraction of its history.
    if (!client.budget.canAfford(CORE_REQUESTS_PER_REPO)) {
      rateLimited = true;
      perRepo.push({ slug: repo.slug, rows: 0, error: "skipped: insufficient API budget" });
      continue;
    }

    try {
      const outcome = await syncRepo(client, repo, lookback);
      rowsWritten += outcome.rows;
      // Truncation is an expected outcome of a bounded page budget, not a
      // failure: the next run picks up from the watermark.
      perRepo.push({ slug: repo.slug, rows: outcome.rows, truncated: outcome.truncated });
      enrichQueue.push({ slug: repo.slug, numbers: outcome.mergedPullNumbers });
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

  if ((options.enrich ?? true) && client.budget.remaining > 0) {
    try {
      rowsWritten += await enrichPullRequests(client, enrichQueue);
    } catch (error) {
      if (error instanceof RateLimitError || error instanceof BudgetExhaustedError) {
        rateLimited = true;
      } else {
        throw error;
      }
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
