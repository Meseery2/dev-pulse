import type { GitHubClient } from "./client";

export interface GhCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date: string } | null;
    committer: { date: string } | null;
  };
  author: { login: string; type?: string } | null;
  parents: { sha: string }[];
}

export interface GhPullRequest {
  id: number;
  number: number;
  state: string;
  draft?: boolean;
  user: { login: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GhReviewComment {
  id: number;
  pull_request_url: string;
  created_at: string;
  user: { login: string; type?: string } | null;
}

export interface GhReview {
  id: number;
  submitted_at: string | null;
  user: { login: string; type?: string } | null;
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  run_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export const COMMITS_PER_PAGE = 100;

export async function fetchCommits(
  client: GitHubClient,
  slug: string,
  branch: string,
  options: { maxPages?: number; since?: Date; etag?: string | null } = {},
) {
  const params = new URLSearchParams({ sha: branch, per_page: String(COMMITS_PER_PAGE) });
  if (options.since) params.set("since", options.since.toISOString());
  return client.paginate<GhCommit>(`/repos/${slug}/commits?${params}`, {
    maxPages: options.maxPages ?? 2,
    etag: options.etag,
  });
}

export async function fetchPullRequests(
  client: GitHubClient,
  slug: string,
  options: { maxPages?: number; updatedSince?: Date; etag?: string | null } = {},
) {
  const params = new URLSearchParams({
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: "100",
  });
  const cutoff = options.updatedSince?.getTime();
  return client.paginate<GhPullRequest>(`/repos/${slug}/pulls?${params}`, {
    maxPages: options.maxPages ?? 2,
    etag: options.etag,
    // Results are newest-updated first, so once a whole page predates the
    // watermark there is nothing newer further back.
    shouldStop: cutoff
      ? (page) => page.length > 0 && page.every((pr) => new Date(pr.updated_at).getTime() < cutoff)
      : undefined,
  });
}

/**
 * Repository-wide review comments. Fetching these in bulk avoids one request
 * per pull request, which is what makes review-latency affordable inside a
 * 60 requests/hour unauthenticated budget.
 */
export async function fetchReviewComments(
  client: GitHubClient,
  slug: string,
  options: { maxPages?: number; since?: Date; etag?: string | null } = {},
) {
  const params = new URLSearchParams({
    sort: "created",
    direction: "desc",
    per_page: "100",
  });
  if (options.since) params.set("since", options.since.toISOString());
  return client.paginate<GhReviewComment>(`/repos/${slug}/pulls/comments?${params}`, {
    maxPages: options.maxPages ?? 2,
    etag: options.etag,
  });
}

export async function fetchWorkflowRuns(
  client: GitHubClient,
  slug: string,
  options: { maxPages?: number; createdSince?: Date; etag?: string | null } = {},
) {
  const params = new URLSearchParams({ per_page: "100" });
  if (options.createdSince) {
    params.set("created", `>=${options.createdSince.toISOString().slice(0, 10)}`);
  }
  const result = await client.paginate<{ workflow_runs?: GhWorkflowRun[] }>(
    `/repos/${slug}/actions/runs?${params}`,
    { maxPages: options.maxPages ?? 2, etag: options.etag },
  );

  // This endpoint returns an object, not an array, so `paginate` collects the
  // envelope per page and the runs are flattened here.
  const runs = result.items.flatMap((envelope) => envelope?.workflow_runs ?? []);
  return { ...result, items: runs };
}

/** Opportunistic per-PR enrichment for size metrics; only called when budget allows. */
export async function fetchPullRequestDetail(client: GitHubClient, slug: string, number: number) {
  const response = await client.request<GhPullRequest>(`/repos/${slug}/pulls/${number}`);
  return response.data;
}
