export type MetricKey =
  | "deployment_frequency"
  | "lead_time_for_changes"
  | "change_failure_rate"
  | "failed_deploy_recovery_time"
  | "review_responsiveness"
  | "change_batch_size"
  | "pr_throughput"
  | "flow_efficiency"
  | "unplanned_work_ratio";

export type MetricFamily = "DORA" | "SPACE" | "Flow";

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  family: MetricFamily;
  unit: "per_day" | "per_week" | "hours" | "ratio" | "count";
  /** Whether a higher value is a better outcome. Drives trend colouring. */
  higherIsBetter: boolean;
  shortDescription: string;
  /** How the number is derived, shown in the UI so a figure can be interrogated. */
  derivation: string;
  caveat: string;
  secondaryLabel?: string;
}

/**
 * Bumping a version invalidates existing snapshots for that metric and forces a
 * recompute, so a definition change can never silently rewrite history.
 */
export const DEFINITION_VERSION = "2026.10.1";

export const METRICS: Record<MetricKey, MetricDefinition> = {
  deployment_frequency: {
    key: "deployment_frequency",
    label: "Deployment Frequency",
    family: "DORA",
    unit: "per_day",
    higherIsBetter: true,
    shortDescription: "How often code reaches production.",
    derivation:
      "Successful production pipeline runs divided by days in the window. Runs concluding skipped, cancelled or action_required are excluded entirely rather than counted as either outcome.",
    caveat:
      "Counts pipeline runs, not user-visible releases. A repository that batches several merges into one release run will look slower than its merge rate suggests.",
    secondaryLabel: "Total deployments",
  },
  lead_time_for_changes: {
    key: "lead_time_for_changes",
    label: "Lead Time for Changes",
    family: "DORA",
    unit: "hours",
    higherIsBetter: false,
    shortDescription: "Time from a commit being authored to reaching production.",
    derivation:
      "For each successful deployment, the commits it shipped are resolved by diffing against the previous successful run of the same pipeline. Lead time is deployment finish minus commit author time, reported as the median across all shipped commits.",
    caveat:
      "Rebases and force-pushes rewrite author timestamps, which shortens the measured lead time for affected commits. Deployments whose predecessor falls outside the ingested history window are excluded rather than estimated.",
    secondaryLabel: "95th percentile",
  },
  change_failure_rate: {
    key: "change_failure_rate",
    label: "Change Failure Rate",
    family: "DORA",
    unit: "ratio",
    higherIsBetter: false,
    shortDescription: "Share of production changes that degraded service.",
    derivation:
      "Deployments linked to a failure signal divided by all completed deployment attempts. Failure signals are a failed pipeline run, a revert of a commit that the deployment shipped, or a linked incident work item.",
    caveat:
      "This is a heuristic, not ground truth. A rollback performed without a revert commit, or an incident that is never linked to a deployment, will not be counted.",
    secondaryLabel: "Failed deployments",
  },
  failed_deploy_recovery_time: {
    key: "failed_deploy_recovery_time",
    label: "Failed Deployment Recovery Time",
    family: "DORA",
    unit: "hours",
    higherIsBetter: false,
    shortDescription: "How long it takes to restore service after a failure.",
    derivation:
      "Median time from a failure signal to the next successful deployment of the same pipeline, or to the resolution of the linked incident.",
    caveat:
      "Failures that are still unresolved at the end of the window are excluded from the median, which biases the figure downward during an ongoing incident.",
    secondaryLabel: "95th percentile",
  },
  review_responsiveness: {
    key: "review_responsiveness",
    label: "Review Responsiveness",
    family: "SPACE",
    unit: "hours",
    higherIsBetter: false,
    shortDescription: "How long a pull request waits for its first review.",
    derivation:
      "Median hours from pull request open to the first review comment authored by somebody other than the pull request author. Bot-authored pull requests are excluded.",
    caveat:
      "Approvals left without a comment are not visible in the bulk comments endpoint, so some reviews are missed and the figure skews high.",
    secondaryLabel: "95th percentile",
  },
  change_batch_size: {
    key: "change_batch_size",
    label: "Change Batch Size",
    family: "SPACE",
    unit: "count",
    higherIsBetter: false,
    shortDescription: "How much change is bundled into each production release.",
    derivation:
      "Median number of commits shipped per successful deployment. Where pull request size data has been enriched, the median changed lines per merged pull request is reported alongside it.",
    caveat:
      "Pull request size enrichment is opportunistic and bounded by the remaining API budget, so the secondary figure may be drawn from a partial sample.",
    secondaryLabel: "Median lines per PR",
  },
  pr_throughput: {
    key: "pr_throughput",
    label: "Merge Throughput",
    family: "Flow",
    unit: "per_week",
    higherIsBetter: true,
    shortDescription: "Merged pull requests per week.",
    derivation: "Pull requests merged within the window, normalised to a weekly rate. Bot-authored pull requests are excluded.",
    caveat:
      "Throughput is a volume measure, not a value measure. It should be read next to batch size, never on its own.",
    secondaryLabel: "Merged in window",
  },
  flow_efficiency: {
    key: "flow_efficiency",
    label: "Flow Efficiency",
    family: "Flow",
    unit: "ratio",
    higherIsBetter: true,
    shortDescription: "Share of cycle time spent actively in progress rather than waiting.",
    derivation:
      "Median of active time divided by total time from creation to completion, across work items completed in the window.",
    caveat:
      "Depends on teams moving tickets promptly. Items that sit in progress after the work has stopped overstate efficiency.",
  },
  unplanned_work_ratio: {
    key: "unplanned_work_ratio",
    label: "Unplanned Work",
    family: "Flow",
    unit: "ratio",
    higherIsBetter: false,
    shortDescription: "Share of completed work that was reactive rather than planned.",
    derivation: "Completed work items typed as bug or incident, divided by all completed work items in the window.",
    caveat:
      "Depends on consistent issue typing. Teams that file bugs as tasks will appear to have less unplanned work than they do.",
  },
};

export const DORA_METRICS: MetricKey[] = [
  "deployment_frequency",
  "lead_time_for_changes",
  "change_failure_rate",
  "failed_deploy_recovery_time",
];

export type DoraBand = "Elite" | "High" | "Medium" | "Low";

/**
 * Thresholds follow the DORA State of DevOps performance clusters. They are
 * directional context for a number, not a target to optimise against.
 */
export function doraBand(key: MetricKey, value: number | null): DoraBand | null {
  if (value === null || Number.isNaN(value)) return null;
  switch (key) {
    case "deployment_frequency":
      if (value >= 1) return "Elite";
      if (value >= 1 / 7) return "High";
      if (value >= 1 / 30) return "Medium";
      return "Low";
    case "lead_time_for_changes":
      if (value < 24) return "Elite";
      if (value < 24 * 7) return "High";
      if (value < 24 * 30) return "Medium";
      return "Low";
    case "change_failure_rate":
      if (value <= 0.05) return "Elite";
      if (value <= 0.1) return "High";
      if (value <= 0.15) return "Medium";
      return "Low";
    case "failed_deploy_recovery_time":
      if (value < 1) return "Elite";
      if (value < 24) return "High";
      if (value < 24 * 7) return "Medium";
      return "Low";
    default:
      return null;
  }
}
