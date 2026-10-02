"use client";

import { InfoIcon, MinusIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import type { MetricCard } from "@/lib/data/views";
import { computeDelta, formatMetric, round } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sparkline } from "@/components/sparkline";

const BAND_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Elite: "default",
  High: "secondary",
  Medium: "outline",
  Low: "destructive",
};

export function MetricTile({ card }: { card: MetricCard }) {
  const delta = computeDelta(card.value, card.previousValue, card.higherIsBetter);
  const hasData = card.value !== null;

  return (
    <Card className="gap-4 border-white/10 bg-white/[0.05] backdrop-blur-sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 font-semibold text-muted-foreground">
          {card.label}
          <Tooltip>
            <TooltipTrigger
              className="text-muted-foreground/70 hover:text-foreground"
              aria-label={`How ${card.label} is calculated`}
            >
              <InfoIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-bold">How this is calculated</p>
              <p className="mt-1 font-medium">{card.derivation}</p>
              <p className="mt-2 font-bold">Known limitation</p>
              <p className="mt-1 font-medium">{card.caveat}</p>
            </TooltipContent>
          </Tooltip>
        </CardDescription>

        <CardTitle className="text-3xl font-extrabold tracking-tight tabular-nums">
          {formatMetric(card.value, card.unit)}
        </CardTitle>

        <CardAction className="flex flex-col items-end gap-1">
          {card.band ? (
            <Badge variant={BAND_VARIANT[card.band] ?? "outline"}>{card.band}</Badge>
          ) : (
            <Badge variant="outline">{card.family}</Badge>
          )}
          {card.isSeeded ? (
            <Badge variant="outline">Seeded</Badge>
          ) : card.hasSeededInputs ? (
            <Badge variant="outline">Mixed</Badge>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <Sparkline
          points={card.trend}
          unit={card.unit}
          positive={delta?.improved !== false}
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {delta ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                delta.improved === true && "text-emerald-600 dark:text-emerald-400",
                delta.improved === false && "text-destructive",
              )}
            >
              {delta.direction === "up" ? (
                <TrendingUpIcon className="size-3.5" />
              ) : delta.direction === "down" ? (
                <TrendingDownIcon className="size-3.5" />
              ) : (
                <MinusIcon className="size-3.5" />
              )}
              {delta.direction === "flat" ? "Unchanged" : `${round(delta.percent, 0)}%`}
            </span>
          ) : null}

          {card.secondaryLabel && card.secondaryValue !== null ? (
            <span>
              {card.secondaryLabel}: {formatSecondary(card)}
            </span>
          ) : null}

          {hasData ? <span>n = {card.sampleSize}</span> : <span>No data in this window</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function formatSecondary(card: MetricCard): string {
  // The secondary figure on a rate metric is a raw count, not another rate.
  const unit =
    card.unit === "per_day" || card.unit === "per_week" || card.unit === "ratio"
      ? "count"
      : card.unit;
  return formatMetric(card.secondaryValue, unit);
}
