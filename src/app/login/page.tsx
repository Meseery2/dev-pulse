import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActivityIcon } from "lucide-react";
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
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ActivityIcon className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {sourcesConfig.org.name} delivery metrics
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to see DORA and flow metrics for your scope.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Your account determines which data you can see. Squad leads see their own squad;
              the executive account sees organisation-level roll-ups only.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <LoginForm />
            <Separator />
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Demo accounts</p>
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono text-foreground">admin</code>
                  <Badge variant="secondary">Office of the CEO</Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono text-foreground">manager1</code>
                  <Badge variant="secondary">Runtime squad</Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <code className="font-mono text-foreground">manager2</code>
                  <Badge variant="secondary">Experience squad</Badge>
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                Passwords are listed in the project README.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
