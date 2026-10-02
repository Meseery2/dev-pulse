"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { formatDate, formatMetric } from "@/lib/format";
import type { MetricPoint } from "@/lib/data/views";

interface SparklineProps {
  points: MetricPoint[];
  unit: string;
  positive: boolean;
}

export function Sparkline({ points, unit, positive }: SparklineProps) {
  const data = points.filter((point) => point.value !== null);
  if (data.length < 2) {
    return (
      <div className="flex h-14 items-center text-xs text-muted-foreground">
        Not enough history yet
      </div>
    );
  }

  const stroke = positive ? "var(--chart-1)" : "var(--chart-5)";
  const gradientId = `spark-${unit}-${positive ? "pos" : "neg"}`;

  return (
    <div className="h-14 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as MetricPoint;
              return (
                <div className="rounded-md border bg-popover px-2 py-1 text-xs shadow-md">
                  <div className="font-medium">{formatMetric(point.value, unit)}</div>
                  <div className="text-muted-foreground">
                    28 days to {formatDate(point.periodEnd)}
                  </div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
