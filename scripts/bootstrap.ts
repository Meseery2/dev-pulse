import "dotenv/config";
import { sql } from "drizzle-orm";
import { applySchema } from "../src/lib/db/migrate";
import { db, getPool } from "../src/lib/db";
import { seedAccounts } from "../src/lib/auth/accounts";
import { syncConfigEntities } from "../src/lib/ingest/normalize";
import { generateSyntheticData } from "../src/lib/seed/synthetic";
import { materializeSnapshots } from "../src/lib/metrics/snapshots";
import { metricSnapshots } from "../src/lib/db/schema";

/**
 * Idempotent boot for Render (and local first-run). Applies schema, ensures
 * demo accounts exist, and seeds synthetic metrics only when the database is
 * empty — so a free-tier cold start does not wipe live sync data.
 */
async function main() {
  await applySchema();
  await syncConfigEntities();

  const accounts = await seedAccounts();
  console.log(`accounts: ${accounts.map((a) => `${a.username}(${a.role})`).join(", ")}`);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(metricSnapshots);

  if (count === 0) {
    const summary = await generateSyntheticData();
    console.log("synthetic data:", summary);
  } else {
    console.log(`skipping synthetic seed (${count} snapshots already present)`);
  }

  const snapshots = await materializeSnapshots();
  console.log("snapshots:", snapshots);

  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
