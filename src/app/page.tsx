import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSession();
  redirect(session ? landingPathFor(session) : "/login");
}
