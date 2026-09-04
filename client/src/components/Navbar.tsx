import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, Trophy, Activity, Briefcase, Compass } from "lucide-react";
import { useEffect, useState } from "react";
import type { User } from "@shared/schema";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./UserAvatar";
import { Button } from "@/components/ui/button";

const links = [
  { href: "/", label: "Markets", icon: Compass },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
];

export function Navbar() {
  const [location, navigate] = useLocation();
  const { data: me } = useQuery<Omit<User, "sessionId">>({ queryKey: ["/api/me"] });
  const [q, setQ] = useState("");

  // Keep the search box in sync with ?q= on the markets page.
  useEffect(() => {
    if (!location.startsWith("/")) return;
    const params = new URLSearchParams(window.location.search);
    setQ(params.get("q") ?? "");
  }, [location]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground font-black">
            F
          </span>
          <span className="hidden sm:block text-lg font-bold tracking-tight">Foresight</span>
        </Link>

        <form onSubmit={submit} className="relative flex-1 max-w-xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search markets"
            className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </form>

        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:text-foreground",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
            <Link href="/create">
              <Plus className="h-4 w-4" /> Create
            </Link>
          </Button>
          {me && (
            <Link href="/portfolio" className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 hover:bg-accent">
              <div className="text-right leading-tight">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cash</div>
                <div className="text-sm font-semibold tabular text-yes">{usd(me.balance)}</div>
              </div>
              <UserAvatar seed={me.avatarSeed} name={me.username} size={30} />
            </Link>
          )}
        </div>
      </div>

      {/* mobile nav */}
      <nav className="md:hidden flex border-t border-border/60">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? location === "/" : location.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
        <Link
          href="/create"
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
            location === "/create" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Plus className="h-4 w-4" />
          Create
        </Link>
      </nav>
    </header>
  );
}
