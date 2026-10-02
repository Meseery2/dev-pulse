import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __epdPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and set it.");
  }

  // Render's managed Postgres terminates TLS with a certificate chain that is
  // not in the default trust store, so verification is relaxed for non-local
  // hosts only.
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);
  return new Pool({
    connectionString,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function getPool(): Pool {
  if (!globalThis.__epdPool) {
    globalThis.__epdPool = createPool();
  }
  return globalThis.__epdPool;
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

// Lazily resolved so that importing this module during a build (where
// DATABASE_URL may be absent) does not attempt to open a connection.
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

export { schema };
