import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  metricSnapshots,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  syncRuns,
  workItems as workItemsTable,
} from "../db/schema";
import { requireExec, requireSquadAccess } from "../auth/guard";
import { sourcesConfig, type SquadConfig } from "../config/sources";
import { DORA_METRICS, METRICS, doraBand, type MetricKey } from "../metrics/definitions";
import { DEFAULT_WINDOW_DAYS } from "../metrics/snapshots";

export interface MetricPoint {
  periodEnd: string;
  value: number | null;
}

export interface MetricCard {
  key: MetricKey;
  label: string;
  family: string;
  unit: string;
  higherIsBetter: boolean;
  shortDescription: string;
  derivation: string;
  caveat: string;
  secondaryLabel?: string;
  value: number | null;
  secondaryValue: number | null;
  numerator: number | null;
  denominator: number | null;
  sampleSize: number;
  previousValue: number | null;
  band: string | null;
  hasSeededInputs: boolean;
  trend: MetricPoint[];
}

export interface Freshness {
  lastSyncedAt: string | null;
  status: string | null;
  message: string | null;
  rateLimited: boolean;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadCards(scopeType: "org" | "squad" | "repo", scopeId: string): Promise<MetricCard[]> {
  const rows = await db
    .select()
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.scopeType, scopeType),
        eq(metricSnapshots.scopeId, scopeId),
        eq(metricSnapshots.windowDays, DEFAULT_WINDOW_DAYS),
      ),
    )
    .orderBy(asc(metricSnapshots.periodEnd));

  const byMetric = new Map<MetricKey, typeof rows>();
  for (const row of rows) {
    const key = row.metricKey as MetricKey;
    const list = byMetric.get(key) ?? [];
    list.push(row);
    byMetric.set(key, list);
  }

  const cards: MetricCard[] = [];
  for (const [key, definition] of Object.entries(METRICS) as [MetricKey, (typeof METRICS)[MetricKey]][]) {
    const series = byMetric.get(key) ?? [];
    const latest = series[series.length - 1];
    // Four weekly points back is one full window earlier, so the comparison is
    // against a non-overlapping period rather than a rolling neighbour.
    const previous = series[series.length - 5];
    const value = latest ? toNumber(latest.value) : null;

    cards.push({
      key,
      label: definition.label,
      family: definition.family,
      unit: definition.unit,
      higherIsBetter: definition.higherIsBetter,
      shortDescription: definition.shortDescription,
      derivation: definition.derivation,
      caveat: definition.caveat,
      secondaryLabel: definition.secondaryLabel,
      value,
      secondaryValue: latest ? toNumber(latest.secondaryValue) : null,
      numerator: latest ? toNumber(latest.numerator) : null,
      denominator: latest ? toNumber(latest.denominator) : null,
      sampleSize: latest?.sampleSize ?? 0,
      previousValue: previous ? toNumber(previous.value) : null,
      band: doraBand(key, value),
      hasSeededInputs: latest?.hasSeededInputs ?? false,
      trend: series.map((row) => ({
        periodEnd: row.periodEnd.toISOString(),
        value: toNumber(row.value),
      })),
    });
  }

  return cards;
}

export async function getFreshness(): Promise<Freshness> {
  const [row] = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(1);
  if (!row) return { lastSyncedAt: null, status: null, message: null, rateLimited: false };
  return {
    lastSyncedAt: (row.finishedAt ?? row.startedAt).toISOString(),
    status: row.status,
    message: row.message,
    rateLimited: row.rateLimited,
  };
}

export interface SquadSummary {
  id: string;
  name: string;
  description: string;
  contributorCount: number;
  /** Null when the squad falls below the k-anonymity floor and is suppressed. */
  dora: { key: MetricKey; label: string; value: number | null; band: string | null; unit: string }[] | null;
  suppressed: boolean;
  provenance: "live" | "seeded" | "mixed";
}

function provenanceFor(squad: SquadConfig): "live" | "seeded" | "mixed" {
  const kinds = new Set(
    squad.repos.map((slug) => sourcesConfig.repos.find((r) => r.slug === slug)?.provenance),
  );
  if (kinds.size === 1) return [...kinds][0] === "seeded" ? "seeded" : "live";
  return "mixed";
}

export interface ExecView {
  orgName: string;
  cards: MetricCard[];
  squads: SquadSummary[];
  investmentMix: { type: string; count: number; share: number }[];
  freshness: Freshness;
  kAnonymityFloor: number;
  viewer: { displayName: string; username: string; role: string };
}

/**
 * The exec payload is assembled entirely from aggregates. No contributor
 * identifier, repository-level row, or individual work item is read here, so
 * there is nothing person-shaped for a client to inspect even in principle.
 */
export async function getExecView(): Promise<ExecView> {
  const session = await requireExec("org");
  const floor = sourcesConfig.org.kAnonymityFloor;

  const cards = await loadCards("org", "org");

  const squads: SquadSummary[] = [];
  for (const squad of sourcesConfig.squads) {
    const squadCards = await loadCards("squad", squad.id);
    const contributorCount = await countContributors(squad.id);
    const suppressed = contributorCount < floor;

    squads.push({
      id: squad.id,
      name: squad.name,
      description: squad.description,
      contributorCount,
      suppressed,
      provenance: provenanceFor(squad),
      dora: suppressed
        ? null
        : DORA_METRICS.map((key) => {
            const card = squadCards.find((c) => c.key === key)!;
            return { key, label: card.label, value: card.value, band: card.band, unit: card.unit };
          }),
    });
  }

  const mixRows = await db
    .select({ type: workItemsTable.type, count: sql<number>`count(*)::int` })
    .from(workItemsTable)
    .where(sql`${workItemsTable.completedAt} >= now() - interval '28 days'`)
    .groupBy(workItemsTable.type);
  const mixTotal = mixRows.reduce((sum, row) => sum + row.count, 0) || 1;

  return {
    orgName: sourcesConfig.org.name,
    cards,
    squads,
    investmentMix: mixRows
      .map((row) => ({ type: row.type, count: row.count, share: row.count / mixTotal }))
      .sort((a, b) => b.count - a.count),
    freshness: await getFreshness(),
    kAnonymityFloor: floor,
    viewer: { displayName: session.displayName, username: session.username, role: session.role },
  };
}

async function countContributors(squadId: string): Promise<number> {
  const squad = sourcesConfig.squads.find((s) => s.id === squadId);
  if (!squad || squad.repos.length === 0) return 0;

  const [latest] = await db
    .select({ contributorCount: metricSnapshots.contributorCount })
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.scopeType, "squad"), eq(metricSnapshots.scopeId, squadId)))
    .orderBy(desc(metricSnapshots.periodEnd))
    .limit(1);

  return latest?.contributorCount ?? 0;
}

export interface RepoBreakdown {
  slug: string;
  isSeeded: boolean;
  deploymentFrequency: number | null;
  leadTimeHours: number | null;
  changeFailureRate: number | null;
  deployments: number | null;
}

export interface ReviewQueueEntry {
  repoSlug: string;
  number: number;
  openedAt: string;
  ageHours: number;
}

export interface SquadView {
  squad: { id: string; name: string; description: string; provenance: string };
  cards: MetricCard[];
  repos: RepoBreakdown[];
  reviewQueue: ReviewQueueEntry[];
  openWorkItems: { state: string; count: number }[];
  freshness: Freshness;
  viewer: { displayName: string; username: string; role: string };
}

/**
 * Squad detail deliberately stops short of individual attribution. The review
 * queue identifies pull requests that are waiting, not the people they are
 * waiting on: the intent is to unblock flow, not to rank engineers.
 */
export async function getSquadView(squadId: string): Promise<SquadView> {
  const session = await requireSquadAccess(squadId);
  const squad = sourcesConfig.squads.find((s) => s.id === squadId);
  if (!squad) throw new Error(`unknown squad ${squadId}`);

  const cards = await loadCards("squad", squadId);

  const repos: RepoBreakdown[] = [];
  for (const slug of squad.repos) {
    const repoCards = await loadCards("repo", slug);
    const [repoRow] = await db
      .select({ isSeeded: repositoriesTable.isSeeded })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.slug, slug))
      .limit(1);
    const find = (key: MetricKey) => repoCards.find((c) => c.key === key);
    repos.push({
      slug,
      isSeeded: repoRow?.isSeeded ?? false,
      deploymentFrequency: find("deployment_frequency")?.value ?? null,
      leadTimeHours: find("lead_time_for_changes")?.value ?? null,
      changeFailureRate: find("change_failure_rate")?.value ?? null,
      deployments: find("deployment_frequency")?.secondaryValue ?? null,
    });
  }

  const queueRows = await db
    .select({
      repoSlug: pullRequestsTable.repoSlug,
      number: pullRequestsTable.number,
      openedAt: pullRequestsTable.openedAt,
    })
    .from(pullRequestsTable)
    .where(
      and(
        inArray(pullRequestsTable.repoSlug, squad.repos),
        isNull(pullRequestsTable.firstReviewAt),
        isNull(pullRequestsTable.closedAt),
        eq(pullRequestsTable.isDraft, false),
      ),
    )
    .orderBy(asc(pullRequestsTable.openedAt))
    .limit(8);

  const now = Date.now();
  const reviewQueue = queueRows.map((row) => ({
    repoSlug: row.repoSlug,
    number: row.number,
    openedAt: row.openedAt.toISOString(),
    ageHours: (now - row.openedAt.getTime()) / 3_600_000,
  }));

  const openWorkItems = await db
    .select({ state: workItemsTable.state, count: sql<number>`count(*)::int` })
    .from(workItemsTable)
    .where(and(eq(workItemsTable.squadId, squadId), isNull(workItemsTable.completedAt)))
    .groupBy(workItemsTable.state);

  return {
    squad: {
      id: squad.id,
      name: squad.name,
      description: squad.description,
      provenance: provenanceFor(squad),
    },
    cards,
    repos,
    reviewQueue,
    openWorkItems,
    freshness: await getFreshness(),
    viewer: { displayName: session.displayName, username: session.username, role: session.role },
  };
}
