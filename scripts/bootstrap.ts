import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { applySchema } from "../src/lib/db/migrate";
import { db, getPool } from "../src/lib/db";
import { seedAccounts } from "../src/lib/auth/accounts";
import { syncConfigEntities } from "../src/lib/ingest/normalize";
import { generateSyntheticData } from "../src/lib/seed/synthetic";
import { materializeSnapshots } from "../src/lib/metrics/snapshots";
import { commits, metricSnapshots } from "../src/lib/db/schema";
import { seededRepos } from "../src/lib/config/sources";

/**
 * Idempotent boot for Render (and local first-run). Applies schema, ensures
 * demo accounts exist, and seeds synthetic metrics when the database is empty
 * or a configured seeded repo has no rows yet.
 */
async function main() {
  await applySchema();
  await syncConfigEntities();

  const accounts = await seedAccounts();
  console.log(`accounts: ${accounts.map((a) => `${a.username}(${a.role})`).join(", ")}`);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(metricSnapshots);

  let needsSeed = count === 0;
  if (!needsSeed) {
    for (const repo of seededRepos()) {
      const [{ repoCount }] = await db
        .select({ repoCount: sql<number>`count(*)::int` })
        .from(commits)
        .where(eq(commits.repoSlug, repo.slug));
      if (repoCount === 0) {
        needsSeed = true;
        break;
      }
    }
  }

  if (needsSeed) {
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
