import { sql } from "drizzle-orm";
import { db } from "../db";
import { rawEvents } from "../db/schema";
import { stableId } from "../util/identity";

export interface RawRecord {
  source: string;
  kind: string;
  externalId: string;
  repoSlug: string | null;
  payload: unknown;
  occurredAt: Date | null;
}

/**
 * Idempotent by (source, kind, external_id): re-running a sync over data that
 * was already captured is a no-op, which is what makes partial syncs safe to
 * retry after a rate-limit stop.
 */
export async function writeRawEvents(records: RawRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const rows = chunk.map((record) => ({
      id: stableId(record.source, record.kind, record.externalId),
      source: record.source,
      kind: record.kind,
      externalId: record.externalId,
      repoSlug: record.repoSlug,
      payload: record.payload as object,
      occurredAt: record.occurredAt,
      fetchedAt: new Date(),
    }));

    const result = await db
      .insert(rawEvents)
      .values(rows)
      .onConflictDoUpdate({
        target: [rawEvents.source, rawEvents.kind, rawEvents.externalId],
        set: {
          payload: sql`excluded.payload`,
          occurredAt: sql`excluded.occurred_at`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    written += result.rowCount ?? chunk.length;
  }
  return written;
}

export async function readRawEvents<T>(
  source: string,
  kind: string,
  repoSlug?: string,
): Promise<T[]> {
  const rows = await db
    .select({ payload: rawEvents.payload })
    .from(rawEvents)
    .where(
      repoSlug
        ? sql`${rawEvents.source} = ${source} AND ${rawEvents.kind} = ${kind} AND ${rawEvents.repoSlug} = ${repoSlug}`
        : sql`${rawEvents.source} = ${source} AND ${rawEvents.kind} = ${kind}`,
    );
  return rows.map((row) => row.payload as T);
}
