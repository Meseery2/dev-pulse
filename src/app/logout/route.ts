import { NextResponse } from "next/server";
import { SESSION_COOKIE, clearSessionCookie } from "@/lib/auth/session";

/**
 * Public origin as seen by the client. Render (and most reverse proxies)
 * bind the app to 0.0.0.0:$PORT, so `request.url` is not a browser-reachable
 * location — use forwarded host/proto instead.
 */
function publicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = (forwardedHost ?? request.headers.get("host") ?? "").split(",")[0]?.trim();
  const proto = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0]?.trim();
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  await clearSessionCookie();

  const response = NextResponse.redirect(new URL("/login", publicOrigin(request)), {
    status: 303,
  });

  // Clear with the same attributes used when setting the cookie so browsers
  // that match on Secure/SameSite actually drop it.
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
