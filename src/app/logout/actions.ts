"use server";

import { redirect } from "next/navigation";
import { clearSessionCookie } from "@/lib/auth/session";

/**
 * Prefer a server action over a route-handler redirect: on Render,
 * `new URL("/login", request.url)` resolves to the internal bind
 * address (`0.0.0.0:$PORT`), which browsers cannot follow.
 */
export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
