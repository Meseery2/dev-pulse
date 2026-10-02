export function formatMetric(value: number | null, unit: string): string {
  if (value === null || Number.isNaN(value)) return "—";

  switch (unit) {
    case "per_day":
      // Below roughly one a day, a weekly rate is far easier to reason about
      // than a fraction.
      return value >= 1
        ? `${round(value, 2)} / day`
        : `${round(value * 7, 1)} / week`;
    case "per_week":
      return `${round(value, 1)} / week`;
    case "hours":
      return formatDuration(value);
    case "ratio":
      return `${round(value * 100, 1)}%`;
    case "count":
      return `${round(value, 1)}`;
    default:
      return `${round(value, 2)}`;
  }
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${round(hours, 1)} h`;
  return `${round(hours / 24, 1)} d`;
}

export function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface Delta {
  direction: "up" | "down" | "flat";
  percent: number;
  improved: boolean | null;
}

export function computeDelta(
  value: number | null,
  previous: number | null,
  higherIsBetter: boolean,
): Delta | null {
  if (value === null || previous === null) return null;
  if (previous === 0 && value === 0) return { direction: "flat", percent: 0, improved: null };
  if (previous === 0) return null;

  const change = (value - previous) / Math.abs(previous);
  // Movements under two percent are noise at these sample sizes and are shown
  // as flat rather than dressed up as a trend.
  if (Math.abs(change) < 0.02) return { direction: "flat", percent: 0, improved: null };

  return {
    direction: change > 0 ? "up" : "down",
    percent: Math.abs(change) * 100,
    improved: change > 0 ? higherIsBetter : !higherIsBetter,
  };
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
