import { LogOutIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/logout/actions";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  viewer: { displayName: string; role: string };
  scopeLabel: string;
}

export function AppHeader({ title, subtitle, viewer, scopeLabel }: AppHeaderProps) {
  return (
    <header className="border-b border-white/10 bg-[#020b0e]/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary shadow-[0_0_24px_var(--mal-glow)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/mal-mark.svg" alt="MAL" width={18} height={18} className="brightness-0" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-bold tracking-[0.18em] text-primary uppercase">MAL</p>
              <Badge variant="secondary" className="font-semibold">
                {scopeLabel}
              </Badge>
            </div>
            <h1 className="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
              {title}
            </h1>
            <p className="text-sm font-medium text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 md:justify-end">
          <div className="flex flex-col md:items-end">
            <span className="text-sm font-bold">{viewer.displayName}</span>
            <span className="text-xs font-semibold text-muted-foreground">
              {viewer.role === "exec" ? "Leadership access" : "Squad lead access"}
            </span>
          </div>
          <form action={logout}>
            <Button type="submit" variant="outline" size="sm" className="font-bold">
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
