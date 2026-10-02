import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runGitHubSync } from "@/lib/ingest/sync";
import { normalizeGitHub } from "@/lib/ingest/normalize";
import { materializeSnapshots } from "@/lib/metrics/snapshots";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ingestion entry point for the scheduler. It is intentionally not reachable
 * with a user session: a browser cannot trigger a sync, and the shared secret
 * is compared in constant time.
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const sync = await runGitHubSync();
  const normalized = await normalizeGitHub();
  const snapshots = await materializeSnapshots();

  return NextResponse.json({
    sync,
    normalized,
    snapshots,
    durationMs: Date.now() - started,
  });
}
