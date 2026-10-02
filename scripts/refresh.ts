import "dotenv/config";
import { getPool } from "../src/lib/db";
import { normalizeGitHub } from "../src/lib/ingest/normalize";
import { materializeSnapshots } from "../src/lib/metrics/snapshots";

/**
 * Recomputes the canonical model and every metric from data already in the raw
 * store, without touching any source API. This is the path a metric definition
 * change takes.
 */
async function main() {
  const normalized = await normalizeGitHub();
  console.log("normalized:", normalized);
  const snapshots = await materializeSnapshots();
  console.log("snapshots:", snapshots);
  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
