import type { MetricKey } from "./definitions";

export interface DeploymentFact {
  id: string;
  repoSlug: string;
  status: "success" | "failure";
  finishedAt: Date;
  isSeeded: boolean;
}

export interface CommitFact {
  sha: string;
  repoSlug: string;
  authoredAt: Date;
  contributorId: string | null;
  isBot: boolean;
  isSeeded: boolean;
}

export interface PullRequestFact {
  repoSlug: string;
  authorId: string | null;
  isBot: boolean;
  openedAt: Date;
  firstReviewAt: Date | null;
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  isSeeded: boolean;
}

export interface IncidentFact {
  repoSlug: string;
  deploymentId: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
  isSeeded: boolean;
}

export interface WorkItemFact {
  squadId: string | null;
  type: string;
  completedAt: Date | null;
  createdAt: Date;
  activeSeconds: number | null;
  isSeeded: boolean;
}

export interface MetricDataset {
  deployments: DeploymentFact[];
  /** deploymentId -> shipped commit SHAs */
  deploymentCommits: Map<string, string[]>;
  commits: CommitFact[];
  pullRequests: PullRequestFact[];
  incidents: IncidentFact[];
  workItems: WorkItemFact[];
}

export interface Window {
  start: Date;
  end: Date;
}

export interface MetricValue {
  value: number | null;
  secondaryValue: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number;
  contributorCount: number;
  hasSeededInputs: boolean;
}

const HOUR_MS = 3_600_000;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function inWindow(date: Date | null | undefined, window: Window): boolean {
  if (!date) return false;
  const t = date.getTime();
  return t >= window.start.getTime() && t <= window.end.getTime();
}

function windowDays(window: Window): number {
  return Math.max(1, (window.end.getTime() - window.start.getTime()) / 86_400_000);
}

function empty(overrides: Partial<MetricValue> = {}): MetricValue {
  return {
    value: null,
    secondaryValue: null,
    numerator: null,
    denominator: null,
    sampleSize: 0,
    contributorCount: 0,
    hasSeededInputs: false,
    ...overrides,
  };
}

function countContributors(dataset: MetricDataset, window: Window): number {
  const ids = new Set<string>();
  for (const commit of dataset.commits) {
    if (!commit.isBot && commit.contributorId && inWindow(commit.authoredAt, window)) {
      ids.add(commit.contributorId);
    }
  }
  for (const pr of dataset.pullRequests) {
    if (!pr.isBot && pr.authorId && inWindow(pr.openedAt, window)) ids.add(pr.authorId);
  }
  return ids.size;
}

export function computeDeploymentFrequency(dataset: MetricDataset, window: Window): MetricValue {
  const successful = dataset.deployments.filter(
    (d) => d.status === "success" && inWindow(d.finishedAt, window),
  );
  if (successful.length === 0) {
    return empty({ denominator: windowDays(window), numerator: 0, value: 0, secondaryValue: 0 });
  }
  const days = windowDays(window);
  return {
    value: successful.length / days,
    secondaryValue: successful.length,
    numerator: successful.length,
    denominator: days,
    sampleSize: successful.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: successful.some((d) => d.isSeeded),
  };
}

export function computeLeadTime(dataset: MetricDataset, window: Window): MetricValue {
  const commitByKey = new Map(dataset.commits.map((c) => [`${c.repoSlug}::${c.sha}`, c]));
  const leadTimes: number[] = [];
  let seeded = false;

  for (const deployment of dataset.deployments) {
    if (deployment.status !== "success" || !inWindow(deployment.finishedAt, window)) continue;
    const shas = dataset.deploymentCommits.get(deployment.id);
    if (!shas || shas.length === 0) continue;

    for (const sha of shas) {
      const commit = commitByKey.get(`${deployment.repoSlug}::${sha}`);
      if (!commit) continue;
      const hours = (deployment.finishedAt.getTime() - commit.authoredAt.getTime()) / HOUR_MS;
      // A negative lead time means the commit's author date postdates the
      // deployment that shipped it, which only happens through clock skew or a
      // rewritten timestamp. Such commits are dropped rather than clamped.
      if (hours < 0) continue;
      leadTimes.push(hours);
      seeded = seeded || deployment.isSeeded || commit.isSeeded;
    }
  }

  if (leadTimes.length === 0) return empty();
  return {
    value: median(leadTimes),
    secondaryValue: percentile(leadTimes, 0.95),
    numerator: null,
    denominator: null,
    sampleSize: leadTimes.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: seeded,
  };
}

export function computeChangeFailureRate(dataset: MetricDataset, window: Window): MetricValue {
  const attempts = dataset.deployments.filter((d) => inWindow(d.finishedAt, window));
  if (attempts.length === 0) return empty();

  const failedIds = new Set<string>();
  for (const deployment of attempts) {
    if (deployment.status === "failure") failedIds.add(deployment.id);
  }
  const attemptIds = new Set(attempts.map((d) => d.id));
  for (const incident of dataset.incidents) {
    if (incident.deploymentId && attemptIds.has(incident.deploymentId)) {
      failedIds.add(incident.deploymentId);
    }
  }

  return {
    value: failedIds.size / attempts.length,
    secondaryValue: failedIds.size,
    numerator: failedIds.size,
    denominator: attempts.length,
    sampleSize: attempts.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: attempts.some((d) => d.isSeeded),
  };
}

export function computeRecoveryTime(dataset: MetricDataset, window: Window): MetricValue {
  const durations: number[] = [];
  let unresolved = 0;
  let seeded = false;

  for (const incident of dataset.incidents) {
    if (!inWindow(incident.startedAt, window)) continue;
    if (!incident.resolvedAt) {
      unresolved += 1;
      continue;
    }
    const hours = (incident.resolvedAt.getTime() - incident.startedAt.getTime()) / HOUR_MS;
    if (hours < 0) continue;
    durations.push(hours);
    seeded = seeded || incident.isSeeded;
  }

  if (durations.length === 0) return empty({ denominator: unresolved });
  return {
    value: median(durations),
    secondaryValue: percentile(durations, 0.95),
    numerator: durations.length,
    denominator: durations.length + unresolved,
    sampleSize: durations.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: seeded,
  };
}

export function computeReviewResponsiveness(dataset: MetricDataset, window: Window): MetricValue {
  const waits: number[] = [];
  let seeded = false;
  for (const pr of dataset.pullRequests) {
    if (pr.isBot || !inWindow(pr.openedAt, window) || !pr.firstReviewAt) continue;
    const hours = (pr.firstReviewAt.getTime() - pr.openedAt.getTime()) / HOUR_MS;
    if (hours < 0) continue;
    waits.push(hours);
    seeded = seeded || pr.isSeeded;
  }
  if (waits.length === 0) return empty();
  return {
    value: median(waits),
    secondaryValue: percentile(waits, 0.95),
    numerator: null,
    denominator: null,
    sampleSize: waits.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: seeded,
  };
}

export function computeChangeBatchSize(dataset: MetricDataset, window: Window): MetricValue {
  const commitsPerDeploy: number[] = [];
  let seeded = false;
  for (const deployment of dataset.deployments) {
    if (deployment.status !== "success" || !inWindow(deployment.finishedAt, window)) continue;
    const shas = dataset.deploymentCommits.get(deployment.id);
    if (!shas || shas.length === 0) continue;
    commitsPerDeploy.push(shas.length);
    seeded = seeded || deployment.isSeeded;
  }

  const prSizes: number[] = [];
  for (const pr of dataset.pullRequests) {
    if (pr.isBot || !pr.mergedAt || !inWindow(pr.mergedAt, window)) continue;
    if (pr.additions === null || pr.deletions === null) continue;
    prSizes.push(pr.additions + pr.deletions);
  }

  if (commitsPerDeploy.length === 0 && prSizes.length === 0) return empty();
  return {
    value: median(commitsPerDeploy),
    secondaryValue: median(prSizes),
    numerator: null,
    denominator: null,
    sampleSize: commitsPerDeploy.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: seeded,
  };
}

export function computePrThroughput(dataset: MetricDataset, window: Window): MetricValue {
  const merged = dataset.pullRequests.filter((pr) => !pr.isBot && inWindow(pr.mergedAt, window));
  const weeks = windowDays(window) / 7;
  if (merged.length === 0) return empty({ value: 0, secondaryValue: 0, denominator: weeks });
  return {
    value: merged.length / weeks,
    secondaryValue: merged.length,
    numerator: merged.length,
    denominator: weeks,
    sampleSize: merged.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: merged.some((pr) => pr.isSeeded),
  };
}

export function computeFlowEfficiency(dataset: MetricDataset, window: Window): MetricValue {
  const ratios: number[] = [];
  let seeded = false;
  for (const item of dataset.workItems) {
    if (!inWindow(item.completedAt, window) || item.activeSeconds === null) continue;
    const totalSeconds = (item.completedAt!.getTime() - item.createdAt.getTime()) / 1000;
    if (totalSeconds <= 0) continue;
    ratios.push(Math.min(1, item.activeSeconds / totalSeconds));
    seeded = seeded || item.isSeeded;
  }
  if (ratios.length === 0) return empty();
  return {
    value: median(ratios),
    secondaryValue: null,
    numerator: null,
    denominator: null,
    sampleSize: ratios.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: seeded,
  };
}

export function computeUnplannedWorkRatio(dataset: MetricDataset, window: Window): MetricValue {
  const completed = dataset.workItems.filter((item) => inWindow(item.completedAt, window));
  if (completed.length === 0) return empty();
  const unplanned = completed.filter((item) => item.type === "bug" || item.type === "incident");
  return {
    value: unplanned.length / completed.length,
    secondaryValue: unplanned.length,
    numerator: unplanned.length,
    denominator: completed.length,
    sampleSize: completed.length,
    contributorCount: countContributors(dataset, window),
    hasSeededInputs: completed.some((item) => item.isSeeded),
  };
}

export const COMPUTERS: Record<MetricKey, (d: MetricDataset, w: Window) => MetricValue> = {
  deployment_frequency: computeDeploymentFrequency,
  lead_time_for_changes: computeLeadTime,
  change_failure_rate: computeChangeFailureRate,
  failed_deploy_recovery_time: computeRecoveryTime,
  review_responsiveness: computeReviewResponsiveness,
  change_batch_size: computeChangeBatchSize,
  pr_throughput: computePrThroughput,
  flow_efficiency: computeFlowEfficiency,
  unplanned_work_ratio: computeUnplannedWorkRatio,
};

export function computeAll(dataset: MetricDataset, window: Window): Record<MetricKey, MetricValue> {
  const out = {} as Record<MetricKey, MetricValue>;
  for (const [key, fn] of Object.entries(COMPUTERS) as [MetricKey, typeof computeDeploymentFrequency][]) {
    out[key] = fn(dataset, window);
  }
  return out;
}

export function filterDatasetToRepos(dataset: MetricDataset, repoSlugs: string[]): MetricDataset {
  const allowed = new Set(repoSlugs);
  const deployments = dataset.deployments.filter((d) => allowed.has(d.repoSlug));
  const deploymentIds = new Set(deployments.map((d) => d.id));
  const deploymentCommits = new Map<string, string[]>();
  for (const [id, shas] of dataset.deploymentCommits) {
    if (deploymentIds.has(id)) deploymentCommits.set(id, shas);
  }
  return {
    deployments,
    deploymentCommits,
    commits: dataset.commits.filter((c) => allowed.has(c.repoSlug)),
    pullRequests: dataset.pullRequests.filter((p) => allowed.has(p.repoSlug)),
    incidents: dataset.incidents.filter((i) => allowed.has(i.repoSlug)),
    workItems: dataset.workItems,
  };
}

export function filterWorkItemsToSquads(dataset: MetricDataset, squadIds: string[]): MetricDataset {
  const allowed = new Set(squadIds);
  return {
    ...dataset,
    workItems: dataset.workItems.filter((item) => item.squadId && allowed.has(item.squadId)),
  };
}
