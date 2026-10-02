import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { sourcesConfig } from "../config/sources";
import { stableId } from "../util/identity";

/**
 * Demo passwords are read from the environment. The fallbacks exist so a fresh
 * clone is usable without configuration; they are intentionally obvious so that
 * nobody mistakes this for a credential store suitable for real users.
 */
const FALLBACK_PASSWORDS: Record<string, string> = {
  admin: "exec-demo-2026",
  manager1: "runtime-demo-2026",
  manager2: "experience-demo-2026",
};

function passwordFor(username: string): string {
  const envKey = `${username.toUpperCase()}_PASSWORD`;
  const fromEnv = process.env[envKey]?.trim();
  return fromEnv || FALLBACK_PASSWORDS[username] || `${username}-demo-2026`;
}

export async function seedAccounts(): Promise<{ username: string; role: string }[]> {
  const created: { username: string; role: string }[] = [];

  for (const account of sourcesConfig.accounts) {
    const passwordHash = await bcrypt.hash(passwordFor(account.username), 10);
    await db
      .insert(users)
      .values({
        id: stableId("user", account.username),
        username: account.username,
        passwordHash,
        role: account.role,
        squadId: account.squadId,
        displayName: account.displayName,
      })
      .onConflictDoUpdate({
        target: users.username,
        set: {
          passwordHash: sql`excluded.password_hash`,
          role: sql`excluded.role`,
          squadId: sql`excluded.squad_id`,
          displayName: sql`excluded.display_name`,
        },
      });
    created.push({ username: account.username, role: account.role });
  }

  return created;
}

export async function verifyCredentials(username: string, password: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);

  // Hash even when the user is absent so a missing account and a wrong
  // password take comparable time.
  if (!user) {
    await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return null;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  return {
    userId: user.id,
    username: user.username,
    role: user.role as "exec" | "squad_lead",
    squadId: user.squadId,
    displayName: user.displayName,
  };
}
