import "dotenv/config";
import { applySchema } from "../src/lib/db/migrate";
import { getPool } from "../src/lib/db";
import { seedAccounts } from "../src/lib/auth/accounts";
import { syncConfigEntities } from "../src/lib/ingest/normalize";
import { generateSyntheticData } from "../src/lib/seed/synthetic";
import { materializeSnapshots } from "../src/lib/metrics/snapshots";

async function main() {
  await applySchema();
  await syncConfigEntities();

  const accounts = await seedAccounts();
  console.log(`accounts: ${accounts.map((a) => `${a.username}(${a.role})`).join(", ")}`);

  const summary = await generateSyntheticData();
  console.log("synthetic data:", summary);

  const snapshots = await materializeSnapshots();
  console.log("snapshots:", snapshots);

  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
