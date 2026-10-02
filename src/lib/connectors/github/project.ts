import { hashIdentity, looksLikeBot } from "../../util/identity";
import type { GhCommit, GhPullRequest, GhReviewComment, GhWorkflowRun } from "./resources";

/**
 * Source payloads are projected down to the fields the metric engine actually
 * uses before anything is persisted.
 *
 * Two reasons, both deliberate:
 *
 * 1. Privacy. The product never identifies an individual, so logins are
 *    replaced with salted hashes at the boundary and free-text content —
 *    commit messages, review comment bodies — is never stored at all. The
 *    facts the metrics need (is this a revert? what does it revert?) are
 *    extracted here and the prose is discarded.
 * 2. Size and correctness. Full GitHub payloads are large and occasionally
 *    contain NUL characters, which Postgres `jsonb` cannot represent.
 *
 * The trade-off is that replaying history after changing the identity salt is
 * not possible without re-fetching. That is the right way round: retaining
 * less is worth more than perfect replayability of data we do not want.
 */

export interface RawCommitRecord {
  sha: string;
  authoredAt: string;
  committedAt: string | null;
  branchPosition: number;
  parentCount: number;
  isRevert: boolean;
  revertsSha: string | null;
  authorHash: string | null;
  authorIsBot: boolean;
}

export interface RawPullRecord {
  number: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
  authorHash: string | null;
  authorIsBot: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface RawReviewCommentRecord {
  id: number;
  pullNumber: number | null;
  createdAt: string;
  authorHash: string | null;
  authorIsBot: boolean;
}

export interface RawWorkflowRunRecord {
  id: number;
  name: string | null;
  headSha: string;
  headBranch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const REVERT_SHA = /This reverts commit ([0-9a-f]{7,40})/i;

export function projectCommit(commit: GhCommit, branchPosition: number): RawCommitRecord | null {
  if (!commit?.sha || !commit.commit?.author?.date) return null;
  const message = commit.commit.message ?? "";
  const revertMatch = message.match(REVERT_SHA);
  const login = commit.author?.login ?? null;

  return {
    sha: commit.sha,
    authoredAt: commit.commit.author.date,
    committedAt: commit.commit.committer?.date ?? null,
    branchPosition,
    parentCount: commit.parents?.length ?? 1,
    isRevert: /^Revert[ "]/i.test(message) || REVERT_SHA.test(message),
    revertsSha: revertMatch ? revertMatch[1] : null,
    authorHash: login ? hashIdentity(login) : null,
    authorIsBot: looksLikeBot(login, commit.author?.type),
  };
}

export function projectPullRequest(pr: GhPullRequest): RawPullRecord | null {
  if (!pr?.number || !pr.created_at) return null;
  const login = pr.user?.login ?? null;
  return {
    number: pr.number,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    mergeCommitSha: pr.merge_commit_sha,
    draft: Boolean(pr.draft),
    authorHash: login ? hashIdentity(login) : null,
    authorIsBot: looksLikeBot(login, pr.user?.type),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changed_files ?? null,
  };
}

export function projectReviewComment(comment: GhReviewComment): RawReviewCommentRecord | null {
  if (!comment?.id || !comment.created_at) return null;
  const login = comment.user?.login ?? null;
  return {
    id: comment.id,
    pullNumber: pullNumberFromUrl(comment.pull_request_url),
    createdAt: comment.created_at,
    authorHash: login ? hashIdentity(login) : null,
    authorIsBot: looksLikeBot(login, comment.user?.type),
  };
}

export function projectWorkflowRun(run: GhWorkflowRun): RawWorkflowRunRecord | null {
  if (!run?.id || !run.head_sha) return null;
  return {
    id: run.id,
    name: run.name ?? null,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    runStartedAt: run.run_started_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

export function pullNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pulls\/(\d+)$/);
  return match ? Number(match[1]) : null;
}
