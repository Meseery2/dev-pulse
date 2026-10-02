import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClockIcon, GitPullRequestIcon, UsersIcon } from "lucide-react";
import { getSquadView } from "@/lib/data/views";
import { AuthorizationError } from "@/lib/auth/guard";
import { DORA_METRICS } from "@/lib/metrics/definitions";
import { formatDuration, formatMetric, round } from "@/lib/format";
import { AppHeader } from "@/components/app-header";
import { FreshnessBar } from "@/components/freshness-bar";
import { MetricTile } from "@/components/metric-tile";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Squad delivery" };
export const dynamic = "force-dynamic";

export default async function SquadPage({ params }: { params: Promise<{ squadId: string }> }) {
  const { squadId } = await params;

  let view;
  try {
    view = await getSquadView(squadId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(error.status === 401 ? "/login" : "/denied");
    }
    throw error;
  }

  const dora = view.cards.filter((card) => DORA_METRICS.includes(card.key));
  const supporting = view.cards.filter((card) => !DORA_METRICS.includes(card.key));
  const openTotal = view.openWorkItems.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="min-h-dvh">
      <AppHeader
        title={`${view.squad.name} squad`}
        subtitle={view.squad.description}
        viewer={view.viewer}
        scopeLabel="Squad detail"
      />

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6">
        <FreshnessBar freshness={view.freshness} />

        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-extrabold tracking-tight">Delivery performance</h2>
            <p className="text-sm font-medium text-muted-foreground">
              Rolling 28 days for the repositories this squad owns.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {dora.map((card) => (
              <MetricTile key={card.key} card={card} />
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Repository breakdown</CardTitle>
              <CardDescription>
                Which repositories are driving the squad-level numbers above.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead className="text-right">Deploys</TableHead>
                    <TableHead className="text-right">Lead time</TableHead>
                    <TableHead className="text-right">Change failure</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.repos.map((repo) => (
                    <TableRow key={repo.slug}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{repo.slug}</span>
                          {repo.isSeeded ? <Badge variant="outline">Seeded</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {repo.deployments === null ? "—" : round(repo.deployments, 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {repo.leadTimeHours === null ? "—" : formatDuration(repo.leadTimeHours)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {repo.changeFailureRate === null
                          ? "—"
                          : formatMetric(repo.changeFailureRate, "ratio")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Review queue</CardTitle>
              <CardDescription>
                Open pull requests with no review yet, oldest first. Listed by pull request, not
                by person — the goal is to unblock flow, not to rank anybody.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {view.reviewQueue.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <GitPullRequestIcon />
                    </EmptyMedia>
                    <EmptyTitle>Nothing is waiting</EmptyTitle>
                    <EmptyDescription>
                      Every open pull request in this squad has had a first review.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="flex flex-col gap-3">
                  {view.reviewQueue.map((entry) => (
                    <li
                      key={`${entry.repoSlug}#${entry.number}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {entry.repoSlug.split("/")[1]} #{entry.number}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.repoSlug}
                        </span>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                        <ClockIcon className="size-3.5" />
                        {formatDuration(entry.ageHours)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Flow and collaboration</h2>
            <p className="text-sm text-muted-foreground">
              Review latency and batch size move before lead time does, so these are the levers
              to pull first.
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
              <UsersIcon className="size-4" />
              Work in progress
            </CardTitle>
            <CardDescription>
              {openTotal} open items across this squad, from the project-management connector.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            {view.openWorkItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open work items.</p>
            ) : (
              view.openWorkItems.map((row) => (
                <div key={row.state} className="flex flex-col gap-1">
                  <span className="text-2xl font-semibold tabular-nums">{row.count}</span>
                  <span className="text-xs text-muted-foreground capitalize">
                    {row.state.replace("_", " ")}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
