import type { RepoConfig } from "../config/sources";
import type {
  RawCommitRecord,
  RawPullRecord,
  RawReviewCommentRecord,
  RawWorkflowRunRecord,
} from "../connectors/github/project";
import { stableId } from "../util/identity";

export interface CommitRow {
  sha: string;
  repoSlug: string;
  identityHash: string | null;
  isBot: boolean;
  authoredAt: Date;
  committedAt: Date | null;
  branchPosition: number | null;
  isRevert: boolean;
  revertsSha: string | null;
  isMerge: boolean;
}

export interface PullRequestRow {
  id: string;
  repoSlug: string;
  number: number;
  identityHash: string | null;
  isBot: boolean;
  openedAt: Date;
  readyAt: Date | null;
  firstReviewAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  mergeCommitSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  isDraft: boolean;
}

export interface DeploymentRow {
  id: string;
  repoSlug: string;
  environment: string;
  status: "success" | "failure";
  headSha: string;
  workflowName: string;
  startedAt: Date;
  finishedAt: Date;
}

export interface DeploymentCommitRow {
  deploymentId: string;
  repoSlug: string;
  sha: string;
}

export interface IncidentRow {
  id: string;
  repoSlug: string;
  deploymentId: string | null;
  origin: "failed_deploy" | "revert" | "work_item";
  startedAt: Date;
  resolvedAt: Date | null;
}

export function normalizeCommits(raw: RawCommitRecord[], repoSlug: string): CommitRow[] {
  return raw
    .filter((commit) => commit?.sha && commit.authoredAt)
    .map((commit) => ({
      sha: commit.sha,
      repoSlug,
      identityHash: commit.authorHash,
      isBot: commit.authorIsBot,
      authoredAt: new Date(commit.authoredAt),
      committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
      branchPosition: commit.branchPosition ?? null,
      isRevert: commit.isRevert,
      revertsSha: commit.revertsSha,
      isMerge: (commit.parentCount ?? 1) > 1,
    }));
}

/**
 * First review time is derived from repository-wide review comments rather
 * than per-pull-request review calls, which is what keeps review latency
 * affordable inside a 60 requests/hour budget. A comment by the pull request
 * author is not a review.
 */
export function normalizePullRequests(
  raw: RawPullRecord[],
  details: RawPullRecord[],
  comments: RawReviewCommentRecord[],
  repoSlug: string,
): PullRequestRow[] {
  const detailByNumber = new Map(details.map((d) => [d.number, d]));

  const firstReviewByNumber = new Map<number, { at: Date; authorHash: string | null }>();
  for (const comment of comments) {
    if (comment.pullNumber === null || !comment.createdAt) continue;
    const at = new Date(comment.createdAt);
    const existing = firstReviewByNumber.get(comment.pullNumber);
    if (!existing || at < existing.at) {
      firstReviewByNumber.set(comment.pullNumber, { at, authorHash: comment.authorHash });
    }
  }

  return raw
    .filter((pr) => pr?.number && pr.createdAt)
    .map((pr) => {
      const detail = detailByNumber.get(pr.number);
      const review = firstReviewByNumber.get(pr.number);
      const selfReview =
        review?.authorHash !== null &&
        review?.authorHash !== undefined &&
        pr.authorHash !== null &&
        review.authorHash === pr.authorHash;

      return {
        id: stableId("github", "pr", repoSlug, pr.number),
        repoSlug,
        number: pr.number,
        identityHash: pr.authorHash,
        isBot: pr.authorIsBot,
        openedAt: new Date(pr.createdAt),
        readyAt: pr.draft ? null : new Date(pr.createdAt),
        firstReviewAt: review && !selfReview ? review.at : null,
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
        closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
        mergeCommitSha: pr.mergeCommitSha,
        additions: detail?.additions ?? pr.additions ?? null,
        deletions: detail?.deletions ?? pr.deletions ?? null,
        changedFiles: detail?.changedFiles ?? pr.changedFiles ?? null,
        isDraft: pr.draft,
      };
    });
}

/**
 * Only `success` and `failure` describe a deployment outcome. GitHub also
 * reports `skipped`, `cancelled`, `action_required`, `neutral` and `null`
 * (still running). Counting those as failures would inflate change failure
 * rate; counting them as successes would inflate deployment frequency. They
 * are excluded from both sides of the ratio.
 */
export function normalizeDeployments(
  runs: RawWorkflowRunRecord[],
  repo: RepoConfig,
): DeploymentRow[] {
  const wanted = new Set(repo.deploySignal.workflowNames.map((n) => n.toLowerCase()));
  const branches = new Set(repo.deploySignal.branches);

  return runs
    .filter((run) => {
      if (!run?.name || !wanted.has(run.name.toLowerCase())) return false;
      if (run.headBranch && !branches.has(run.headBranch)) return false;
      if (run.status !== "completed") return false;
      return run.conclusion === "success" || run.conclusion === "failure";
    })
    .map((run) => {
      const startedAt = new Date(run.runStartedAt ?? run.createdAt);
      const finishedAt = new Date(run.updatedAt);
      return {
        id: stableId("github", "deploy", repo.slug, run.id),
        repoSlug: repo.slug,
        environment: "production",
        status: run.conclusion as "success" | "failure",
        headSha: run.headSha,
        workflowName: run.name!,
        startedAt,
        finishedAt: finishedAt >= startedAt ? finishedAt : startedAt,
      };
    });
}

/**
 * Resolves which commits each successful deployment shipped by diffing against
 * the previous successful deployment of the same workflow.
 *
 * Deployments are grouped by workflow because a repository can run more than
 * one production pipeline; interleaving them would produce overlapping commit
 * ranges and double-count lead time.
 *
 * A deployment whose predecessor cannot be located in the ingested commit
 * window is skipped rather than guessed at. An unbounded range would stretch
 * back to the start of history and massively overstate lead time — reporting
 * nothing is better than reporting a fabricated number.
 */
export function joinDeploymentCommits(
  deployments: DeploymentRow[],
  commits: CommitRow[],
): DeploymentCommitRow[] {
  const positionBySha = new Map<string, number>();
  for (const commit of commits) {
    if (commit.branchPosition !== null) positionBySha.set(commit.sha, commit.branchPosition);
  }
  const ordered = commits
    .filter((c) => c.branchPosition !== null)
    .sort((a, b) => a.branchPosition! - b.branchPosition!);

  const rows: DeploymentCommitRow[] = [];
  const byWorkflow = new Map<string, DeploymentRow[]>();
  for (const deployment of deployments) {
    if (deployment.status !== "success") continue;
    const key = `${deployment.repoSlug}::${deployment.workflowName}`;
    const list = byWorkflow.get(key) ?? [];
    list.push(deployment);
    byWorkflow.set(key, list);
  }

  for (const list of byWorkflow.values()) {
    const chronological = [...list].sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime());
    for (let i = 1; i < chronological.length; i += 1) {
      const current = chronological[i];
      const previous = chronological[i - 1];
      const currentPos = positionBySha.get(current.headSha);
      const previousPos = positionBySha.get(previous.headSha);
      if (currentPos === undefined || previousPos === undefined) continue;
      if (previousPos <= currentPos) continue;

      for (const commit of ordered) {
        const pos = commit.branchPosition!;
        if (pos >= currentPos && pos < previousPos) {
          rows.push({ deploymentId: current.id, repoSlug: current.repoSlug, sha: commit.sha });
        }
      }
    }
  }

  return rows;
}

/**
 * Change failures are detected from two independent signals, because neither
 * is sufficient alone: a failed pipeline run catches broken deploys, and a
 * revert catches bad code that deployed cleanly. Linked incident work items
 * are the third signal and arrive from the project-management connector.
 */
export function deriveIncidents(
  deployments: DeploymentRow[],
  commits: CommitRow[],
  deploymentCommits: DeploymentCommitRow[],
): IncidentRow[] {
  const incidents: IncidentRow[] = [];
  const byWorkflow = new Map<string, DeploymentRow[]>();
  for (const deployment of deployments) {
    const key = `${deployment.repoSlug}::${deployment.workflowName}`;
    const list = byWorkflow.get(key) ?? [];
    list.push(deployment);
    byWorkflow.set(key, list);
  }

  for (const list of byWorkflow.values()) {
    const chronological = [...list].sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime());
    for (let i = 0; i < chronological.length; i += 1) {
      const deployment = chronological[i];
      if (deployment.status !== "failure") continue;
      const recovery = chronological.slice(i + 1).find((d) => d.status === "success");
      incidents.push({
        id: stableId("incident", "failed_deploy", deployment.id),
        repoSlug: deployment.repoSlug,
        deploymentId: deployment.id,
        origin: "failed_deploy",
        startedAt: deployment.finishedAt,
        resolvedAt: recovery?.finishedAt ?? null,
      });
    }
  }

  const deploymentBySha = new Map<string, string>();
  for (const row of deploymentCommits) {
    deploymentBySha.set(`${row.repoSlug}::${row.sha}`, row.deploymentId);
  }
  const deploymentById = new Map(deployments.map((d) => [d.id, d]));
  const commitBySha = new Map(commits.map((c) => [`${c.repoSlug}::${c.sha}`, c]));

  for (const commit of commits) {
    if (!commit.isRevert || !commit.revertsSha) continue;
    const target = resolveSha(commitBySha, commit.repoSlug, commit.revertsSha);
    if (!target) continue;
    const deploymentId = deploymentBySha.get(`${commit.repoSlug}::${target}`);
    if (!deploymentId) continue;
    const deployment = deploymentById.get(deploymentId);
    if (!deployment) continue;

    incidents.push({
      id: stableId("incident", "revert", commit.repoSlug, commit.sha),
      repoSlug: commit.repoSlug,
      deploymentId,
      origin: "revert",
      startedAt: deployment.finishedAt,
      resolvedAt: commit.authoredAt,
    });
  }

  return incidents;
}

/** Revert messages often carry an abbreviated SHA, so prefixes must resolve. */
function resolveSha(
  commitBySha: Map<string, CommitRow>,
  repoSlug: string,
  candidate: string,
): string | null {
  if (commitBySha.has(`${repoSlug}::${candidate}`)) return candidate;
  for (const [key, commit] of commitBySha) {
    if (!key.startsWith(`${repoSlug}::`)) continue;
    if (commit.sha.startsWith(candidate)) return commit.sha;
  }
  return null;
}
