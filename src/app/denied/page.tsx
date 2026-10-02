import type { Metadata } from "next";
import Link from "next/link";
import { ShieldXIcon } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export const metadata: Metadata = { title: "Access denied" };
export const dynamic = "force-dynamic";

export default async function DeniedPage() {
  const session = await getSession();

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Empty className="max-w-md border-white/10 bg-white/[0.05]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldXIcon />
          </EmptyMedia>
          <EmptyTitle className="font-extrabold">That data is outside your scope</EmptyTitle>
          <EmptyDescription className="font-medium">
            {session
              ? session.role === "exec"
                ? "MAL leadership accounts see organisation-level roll-ups. Squad detail is restricted to that squad's lead."
                : "Squad leads can only open their own squad. The attempt has been recorded in the access log."
              : "Sign in to continue."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href={session ? landingPathFor(session) : "/login"}>
              {session ? "Back to your dashboard" : "Go to sign in"}
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}
