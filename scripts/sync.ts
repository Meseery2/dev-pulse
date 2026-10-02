import "dotenv/config";
import { applySchema } from "../src/lib/db/migrate";
import { getPool } from "../src/lib/db";
import { runGitHubSync } from "../src/lib/ingest/sync";
import { normalizeGitHub } from "../src/lib/ingest/normalize";
import { materializeSnapshots } from "../src/lib/metrics/snapshots";

async function main() {
  await applySchema();

  const budgetArg = process.argv.find((arg) => arg.startsWith("--budget="));
  const budget = budgetArg ? Number(budgetArg.split("=")[1]) : undefined;

  const sync = await runGitHubSync({ budget });
  console.log("sync:", sync.status, "-", sync.message);
  for (const repo of sync.repos) {
    const notes = [repo.truncated ? "truncated by page limit" : null, repo.error]
      .filter(Boolean)
      .join("; ");
    console.log(`  ${repo.slug}: ${repo.rows} raw rows${notes ? ` (${notes})` : ""}`);
  }

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
