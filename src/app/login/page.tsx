import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/auth/guard";
import { sourcesConfig } from "@/lib/config/sources";
import { LoginForm } from "./login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
  title: "Sign in",
};

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(landingPathFor(session));

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-3xl bg-primary shadow-[0_0_40px_var(--mal-glow)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/mal-mark.svg" alt="MAL" width={26} height={26} className="brightness-0" />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-bold tracking-[0.22em] text-primary uppercase">
              {sourcesConfig.org.name}
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
              Engineering delivery
            </h1>
            <p className="text-sm font-medium text-muted-foreground">
              DORA and flow metrics for MAL squads and leadership.
            </p>
          </div>
        </div>

        <Card className="border-white/10 bg-white/[0.06] shadow-[0_0_60px_rgba(43,214,115,0.08)] backdrop-blur-md">
          <CardHeader>
            <CardTitle className="text-lg font-extrabold">Sign in</CardTitle>
            <CardDescription className="font-medium">
              Your account determines which data you can see. Squad leads see their own squad;
              leadership sees organisation-level roll-ups only.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <LoginForm />
            <Separator className="bg-white/10" />
            <div className="flex flex-col gap-3">
              <p className="text-sm font-bold">Demo accounts</p>
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono font-semibold text-foreground">admin</code>
                  <Badge variant="secondary" className="font-semibold">
                    MAL Leadership
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono font-semibold text-foreground">manager1</code>
                  <Badge variant="secondary" className="font-semibold">
                    Runtime squad
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono font-semibold text-foreground">manager2</code>
                  <Badge variant="secondary" className="font-semibold">
                    Experience squad
                  </Badge>
                </li>
              </ul>
              <p className="text-xs font-medium text-muted-foreground">
                Passwords are listed in the project README.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
