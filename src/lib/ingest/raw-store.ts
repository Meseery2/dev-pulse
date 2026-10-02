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
 * Postgres `jsonb` cannot represent U+0000, and source systems do emit it
 * inside free-text fields. Payloads are projected before they reach here so
 * this is belt-and-braces, but a single stray NUL would otherwise fail an
 * entire batch.
 */
function stripNulls(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return null;
  if (!serialized.includes("\\u0000")) return payload;
  return JSON.parse(serialized.replace(/\\u0000/g, ""));
}

/**
 * Idempotent by (source, kind, external_id): re-running a sync over data that
 * was already captured is a no-op, which is what makes partial syncs safe to
 * retry after a rate-limit stop.
 */
export async function writeRawEvents(records: RawRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  // Paging through a list that is being updated underneath us returns the same
  // item on more than one page. Postgres rejects an ON CONFLICT DO UPDATE that
  // touches the same row twice in one statement, so duplicates are collapsed
  // here, keeping the most recently fetched copy.
  const deduped = new Map<string, RawRecord>();
  for (const record of records) {
    deduped.set(`${record.source}\u0000${record.kind}\u0000${record.externalId}`, record);
  }
  const unique = [...deduped.values()];

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = chunk.map((record) => ({
      id: stableId(record.source, record.kind, record.externalId),
      source: record.source,
      kind: record.kind,
      externalId: record.externalId,
      repoSlug: record.repoSlug,
      payload: stripNulls(record.payload) as object,
      occurredAt: record.occurredAt,
      fetchedAt: new Date(),
    }));

    try {
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
    } catch (error) {
      // Drizzle embeds every bind parameter in its error message, which for a
      // 500-row batch is megabytes of noise in the logs.
      const cause = error as { code?: string; detail?: string; message?: string };
      throw new Error(
        `failed to write ${chunk.length} ${chunk[0]?.kind} rows for ${chunk[0]?.repoSlug ?? "unknown"}: ` +
          `${cause.code ?? ""} ${cause.detail ?? cause.message ?? "unknown error"}`.trim(),
      );
    }
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
