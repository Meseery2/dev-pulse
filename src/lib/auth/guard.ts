import { db } from "../db";
import { accessLog } from "../db/schema";
import { stableId } from "../util/identity";
import { getSession, type Role, type SessionPayload } from "./session";

export class AuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

async function audit(
  session: SessionPayload | null,
  action: string,
  resource: string,
  allowed: boolean,
  reason?: string,
) {
  try {
    await db.insert(accessLog).values({
      id: stableId("access", session?.username ?? "anonymous", action, resource, Date.now(), Math.random()),
      username: session?.username ?? null,
      role: session?.role ?? null,
      action,
      resource,
      allowed,
      reason: reason ?? null,
    });
  } catch {
    // Auditing must never be the reason a request fails.
  }
}

export async function requireSession(resource: string): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    await audit(null, "read", resource, false, "no valid session");
    throw new AuthorizationError(401, "Authentication required");
  }
  return session;
}

export async function requireRole(role: Role, resource: string): Promise<SessionPayload> {
  const session = await requireSession(resource);
  if (session.role !== role) {
    await audit(session, "read", resource, false, `role ${session.role} may not access ${role} data`);
    throw new AuthorizationError(403, "Your role does not have access to this view");
  }
  await audit(session, "read", resource, true);
  return session;
}

/**
 * Authorization for squad data is row-level, not just role-level: holding the
 * `squad_lead` role is not enough, the session must be scoped to the specific
 * squad being requested. Exec sessions are rejected outright — the exec
 * audience is deliberately not permitted to drill into a single squad.
 */
export async function requireSquadAccess(squadId: string): Promise<SessionPayload> {
  const resource = `squad:${squadId}`;
  const session = await requireSession(resource);

  if (session.role !== "squad_lead") {
    await audit(session, "read", resource, false, "squad detail is restricted to squad leads");
    throw new AuthorizationError(403, "Squad detail is only available to squad leads");
  }
  if (session.squadId !== squadId) {
    await audit(session, "read", resource, false, `session scoped to ${session.squadId ?? "none"}`);
    throw new AuthorizationError(403, "You do not have access to this squad");
  }

  await audit(session, "read", resource, true);
  return session;
}

export async function requireExec(resource = "org"): Promise<SessionPayload> {
  return requireRole("exec", resource);
}

export function landingPathFor(session: SessionPayload): string {
  return session.role === "exec" ? "/exec" : `/squad/${session.squadId}`;
}
