import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EyeOffIcon, ShieldCheckIcon } from "lucide-react";
import { getExecView } from "@/lib/data/views";
import { AuthorizationError } from "@/lib/auth/guard";
import { DORA_METRICS } from "@/lib/metrics/definitions";
import { formatMetric, round } from "@/lib/format";
import { AppHeader } from "@/components/app-header";
import { FreshnessBar } from "@/components/freshness-bar";
import { MetricTile } from "@/components/metric-tile";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Delivery overview" };
export const dynamic = "force-dynamic";

const INVESTMENT_LABEL: Record<string, string> = {
  feature: "New capability",
  bug: "Defect repair",
  maintenance: "Maintenance",
  incident: "Incident response",
};

export default async function ExecPage() {
  let view;
  try {
    view = await getExecView();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(error.status === 401 ? "/login" : "/denied");
    }
    throw error;
  }

  const dora = view.cards.filter((card) => DORA_METRICS.includes(card.key));
  const supporting = view.cards.filter((card) => !DORA_METRICS.includes(card.key));
  const reliability = view.cards.find((card) => card.key === "change_failure_rate");
  const unplanned = view.cards.find((card) => card.key === "unplanned_work_ratio");

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader
        title={`${view.orgName} delivery overview`}
        subtitle="Organisation-level delivery health for the office of the CEO."
        viewer={view.viewer}
        scopeLabel="Organisation"
      />

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
        <FreshnessBar freshness={view.freshness} />

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Delivery performance</h2>
            <p className="text-sm text-muted-foreground">
              The four DORA measures, compared against industry performance bands. Each tile
              explains how it was derived and what it cannot see.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {dora.map((card) => (
              <MetricTile key={card.key} card={card} />
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Squad comparison</CardTitle>
              <CardDescription>
                Roll-ups only. Squads below {view.kAnonymityFloor} contributors are suppressed so
                that a small team cannot be read as an individual.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Squad</TableHead>
                    {DORA_METRICS.map((key) => (
                      <TableHead key={key} className="text-right">
                        {key === "deployment_frequency"
                          ? "Deploy freq."
                          : key === "lead_time_for_changes"
                            ? "Lead time"
                            : key === "change_failure_rate"
                              ? "Change failure"
                              : "Recovery"}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.squads.map((squad) => (
                    <TableRow key={squad.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{squad.name}</span>
                            {squad.provenance !== "live" ? (
                              <Badge variant="outline">
                                {squad.provenance === "seeded" ? "Seeded" : "Mixed"}
                              </Badge>
                            ) : null}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {squad.contributorCount} contributors
                          </span>
                        </div>
                      </TableCell>

                      {squad.dora ? (
                        squad.dora.map((metric) => (
                          <TableCell key={metric.key} className="text-right tabular-nums">
                            <div className="flex flex-col items-end gap-1">
                              <span>{formatMetric(metric.value, metric.unit)}</span>
                              {metric.band ? (
                                <span className="text-xs text-muted-foreground">{metric.band}</span>
                              ) : null}
                            </div>
                          </TableCell>
                        ))
                      ) : (
                        <TableCell colSpan={DORA_METRICS.length} className="text-right">
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <EyeOffIcon className="size-3.5" />
                            Suppressed — below {view.kAnonymityFloor} contributors
                          </span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where the effort went</CardTitle>
              <CardDescription>
                Completed work in the last 28 days, by type. Sourced from the project-management
                connector.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {view.investmentMix.map((entry) => (
                <div key={entry.type} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span>{INVESTMENT_LABEL[entry.type] ?? entry.type}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {round(entry.share * 100, 0)}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(2, entry.share * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Flow and collaboration</h2>
            <p className="text-sm text-muted-foreground">
              Leading indicators that explain the DORA numbers above. Batch size and review
              latency move before lead time does.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {supporting.map((card) => (
              <MetricTile key={card.key} card={card} />
            ))}
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4" />
              What this view deliberately excludes
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              No individual engineer appears anywhere in this product, at any access level.
              Contributor identities are replaced with salted hashes when data is ingested, and
              this view is assembled from aggregates alone.
            </p>
            <p>
              Executive accounts cannot open squad detail. Squad-level figures shown here are
              roll-ups; the per-repository breakdown is available only to that squad&apos;s lead.
            </p>
            {reliability && unplanned ? (
              <p className="text-foreground">
                Reliability read: {formatMetric(reliability.value, reliability.unit)} of production
                changes degraded service, and{" "}
                {formatMetric(unplanned.value, unplanned.unit)} of completed work was unplanned.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
