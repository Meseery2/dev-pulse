import type { RepoConfig } from "../config/sources";
import type {
  GhCommit,
  GhPullRequest,
  GhReviewComment,
  GhWorkflowRun,
} from "../connectors/github/resources";
import { hashIdentity, looksLikeBot, stableId } from "../util/identity";

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

const REVERT_SHA = /This reverts commit ([0-9a-f]{7,40})/i;

export function normalizeCommits(raw: (GhCommit & { __branchPosition?: number })[], repoSlug: string): CommitRow[] {
  return raw
    .filter((commit) => commit?.sha && commit.commit?.author?.date)
    .map((commit) => {
      const login = commit.author?.login ?? null;
      const message = commit.commit.message ?? "";
      const revertMatch = message.match(REVERT_SHA);
      return {
        sha: commit.sha,
        repoSlug,
        identityHash: login ? hashIdentity(login) : null,
        isBot: looksLikeBot(login, commit.author?.type),
        authoredAt: new Date(commit.commit.author!.date),
        committedAt: commit.commit.committer?.date ? new Date(commit.commit.committer.date) : null,
        branchPosition: commit.__branchPosition ?? null,
        isRevert: /^Revert[ "]/i.test(message) || REVERT_SHA.test(message),
        revertsSha: revertMatch ? revertMatch[1] : null,
        isMerge: (commit.parents?.length ?? 0) > 1,
      };
    });
}

/**
 * First review time is derived from repository-wide review comments rather
 * than per-pull-request review calls. Comments authored by the pull request
 * author do not count as a review.
 */
export function normalizePullRequests(
  raw: GhPullRequest[],
  details: GhPullRequest[],
  comments: GhReviewComment[],
  repoSlug: string,
): PullRequestRow[] {
  const detailByNumber = new Map(details.map((d) => [d.number, d]));

  const firstReviewByNumber = new Map<number, { at: Date; login: string | null }>();
  for (const comment of comments) {
    const number = pullNumberFromUrl(comment.pull_request_url);
    if (number === null || !comment.created_at) continue;
    const at = new Date(comment.created_at);
    const existing = firstReviewByNumber.get(number);
    if (!existing || at < existing.at) {
      firstReviewByNumber.set(number, { at, login: comment.user?.login ?? null });
    }
  }

  return raw
    .filter((pr) => pr?.number && pr.created_at)
    .map((pr) => {
      const detail = detailByNumber.get(pr.number);
      const authorLogin = pr.user?.login ?? null;
      const review = firstReviewByNumber.get(pr.number);
      const selfReview =
        review?.login && authorLogin && review.login.toLowerCase() === authorLogin.toLowerCase();

      return {
        id: stableId("github", "pr", repoSlug, pr.number),
        repoSlug,
        number: pr.number,
        identityHash: authorLogin ? hashIdentity(authorLogin) : null,
        isBot: looksLikeBot(authorLogin, pr.user?.type),
        openedAt: new Date(pr.created_at),
        readyAt: pr.draft ? null : new Date(pr.created_at),
        firstReviewAt: review && !selfReview ? review.at : null,
        mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
        closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
        mergeCommitSha: pr.merge_commit_sha ?? null,
        additions: detail?.additions ?? null,
        deletions: detail?.deletions ?? null,
        changedFiles: detail?.changed_files ?? null,
        isDraft: Boolean(pr.draft),
      };
    });
}

export function pullNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pulls\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Only `success` and `failure` conclusions describe a deployment outcome.
 * GitHub also reports `skipped`, `cancelled`, `action_required`, `neutral` and
 * `null` (still running) — counting any of those as a failure would inflate
 * change failure rate, and counting them as successes would inflate deployment
 * frequency. They are excluded from both sides of the ratio.
 */
export function normalizeDeployments(runs: GhWorkflowRun[], repo: RepoConfig): DeploymentRow[] {
  const wanted = new Set(repo.deploySignal.workflowNames.map((n) => n.toLowerCase()));
  const branches = new Set(repo.deploySignal.branches);

  return runs
    .filter((run) => {
      if (!run?.name || !wanted.has(run.name.toLowerCase())) return false;
      if (run.head_branch && !branches.has(run.head_branch)) return false;
      if (run.status !== "completed") return false;
      return run.conclusion === "success" || run.conclusion === "failure";
    })
    .map((run) => {
      const startedAt = new Date(run.run_started_at ?? run.created_at);
      const finishedAt = new Date(run.updated_at);
      return {
        id: stableId("github", "deploy", repo.slug, run.id),
        repoSlug: repo.slug,
        environment: "production",
        status: run.conclusion as "success" | "failure",
        headSha: run.head_sha,
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
 * Deployments are grouped by workflow because a repository can have more than
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
  const ordered = [...commits]
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
    const chronological = [...list].sort(
      (a, b) => a.finishedAt.getTime() - b.finishedAt.getTime(),
    );
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
 * revert catches bad code that deployed cleanly. Work-item incidents are the
 * third signal and arrive from the project-management connector.
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

  // A revert points at the deployment that shipped the reverted commit.
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
