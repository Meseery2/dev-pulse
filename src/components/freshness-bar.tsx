import { CircleAlertIcon, DatabaseIcon, RefreshCwIcon } from "lucide-react";
import type { Freshness } from "@/lib/data/views";
import { formatRelativeTime } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * A dashboard that silently serves stale numbers is worse than one that admits
 * it is stale, so ingestion state is part of the product surface rather than
 * something buried in logs.
 */
export function FreshnessBar({ freshness }: { freshness: Freshness }) {
  if (!freshness.lastSyncedAt) {
    return (
      <Alert>
        <DatabaseIcon />
        <AlertTitle>No ingestion has run yet</AlertTitle>
        <AlertDescription>
          Run <code className="font-mono">npm run data:sync</code> to pull live data from GitHub.
        </AlertDescription>
      </Alert>
    );
  }

  if (freshness.rateLimited || freshness.status === "failed" || freshness.status === "partial") {
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>
          Last sync {formatRelativeTime(freshness.lastSyncedAt)} finished {freshness.status}
        </AlertTitle>
        <AlertDescription>
          {freshness.message ??
            "Some sources did not refresh. Figures below are computed from the most recent data that was stored."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-muted-foreground">
      <RefreshCwIcon className="size-3.5 text-primary" />
      <span>
        Live sources last synced {formatRelativeTime(freshness.lastSyncedAt)}. All figures use a
        rolling 28-day window.
      </span>
    </div>
  );
}
