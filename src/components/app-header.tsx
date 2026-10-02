import { ActivityIcon, LogOutIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  viewer: { displayName: string; role: string };
  scopeLabel: string;
}

export function AppHeader({ title, subtitle, viewer, scopeLabel }: AppHeaderProps) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ActivityIcon className="size-4" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <Badge variant="secondary">{scopeLabel}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 md:justify-end">
          <div className="flex flex-col md:items-end">
            <span className="text-sm font-medium">{viewer.displayName}</span>
            <span className="text-xs text-muted-foreground">
              {viewer.role === "exec" ? "Executive access" : "Squad lead access"}
            </span>
          </div>
          <form action="/logout" method="post">
            <Button type="submit" variant="outline" size="sm">
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
