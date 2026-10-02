import "dotenv/config";
import { applySchema } from "../src/lib/db/migrate";
import { getPool } from "../src/lib/db";

async function main() {
  await applySchema();
  console.log("schema applied");
  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
