import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * This is a user-experience redirect, not an authorization boundary.
 *
 * It only checks whether a session cookie is present, so that signed-out
 * visitors land on the sign-in page instead of a flash of empty dashboard.
 * Every real access decision — is this role allowed, is this session scoped to
 * this squad — happens server-side in the data access layer, which runs for
 * both page renders and API calls. Removing this file would change the
 * redirect behaviour and nothing about what data anyone can read.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/exec/:path*", "/squad/:path*"],
};
