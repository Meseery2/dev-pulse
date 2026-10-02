import "dotenv/config";
import { createSessionToken } from "../src/lib/auth/session";
import { getPool } from "../src/lib/db";

/**
 * Exercises the authorization matrix against a running server. This is the
 * check that matters for the access-control requirement: the roles must differ
 * in what data they can obtain, not merely in which URL they are shown.
 */
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:44817";

interface Case {
  name: string;
  session: { role: "exec" | "squad_lead"; squadId: string | null; username: string } | null;
  path: string;
  expect: number;
}

const cases: Case[] = [
  { name: "anonymous cannot read org metrics", session: null, path: "/api/metrics/org", expect: 401 },
  { name: "anonymous cannot read squad metrics", session: null, path: "/api/metrics/squad/runtime", expect: 401 },
  {
    name: "exec can read org metrics",
    session: { role: "exec", squadId: null, username: "admin" },
    path: "/api/metrics/org",
    expect: 200,
  },
  {
    name: "exec cannot drill into a squad",
    session: { role: "exec", squadId: null, username: "admin" },
    path: "/api/metrics/squad/runtime",
    expect: 403,
  },
  {
    name: "squad lead can read their own squad",
    session: { role: "squad_lead", squadId: "runtime", username: "manager1" },
    path: "/api/metrics/squad/runtime",
    expect: 200,
  },
  {
    name: "squad lead cannot read another squad",
    session: { role: "squad_lead", squadId: "runtime", username: "manager1" },
    path: "/api/metrics/squad/experience",
    expect: 403,
  },
  {
    name: "squad lead cannot read org metrics",
    session: { role: "squad_lead", squadId: "runtime", username: "manager1" },
    path: "/api/metrics/org",
    expect: 403,
  },
];

async function main() {
  let failures = 0;

  for (const testCase of cases) {
    const headers: Record<string, string> = {};
    if (testCase.session) {
      const token = await createSessionToken({
        userId: `verify-${testCase.session.username}`,
        username: testCase.session.username,
        role: testCase.session.role,
        squadId: testCase.session.squadId,
        displayName: testCase.session.username,
      });
      headers.cookie = `epd_session=${token}`;
    }

    const response = await fetch(`${BASE}${testCase.path}`, { headers, redirect: "manual" });
    const ok = response.status === testCase.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${testCase.name} — expected ${testCase.expect}, got ${response.status}`,
    );

    // A 200 for an exec must not contain anything person-shaped.
    if (ok && response.status === 200 && testCase.session?.role === "exec") {
      const body = await response.text();
      const leaks = ["contributorId", "authorId", "identityHash", "login", "email"].filter((field) =>
        body.includes(field),
      );
      if (leaks.length > 0) {
        failures += 1;
        console.log(`FAIL  exec payload contains person-level fields: ${leaks.join(", ")}`);
      } else {
        console.log("PASS  exec payload contains no person-level fields");
      }
    }
  }

  await getPool().end();
  if (failures > 0) {
    console.error(`\n${failures} access-control check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll access-control checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
