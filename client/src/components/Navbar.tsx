import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Briefcase,
  ChevronDown,
  Compass,
  LogOut,
  PlusCircle,
  Search,
  Shield,
  Trophy,
  Wallet,
} from "lucide-react";
import type { Portfolio } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserAvatar } from "@/components/UserAvatar";

const NAV_LINKS = [
  { href: "/markets", label: "Markets", icon: Compass },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/leaderboard", label: "Ranks", icon: Trophy },
] as const;

const MOBILE_TABS = [
  { href: "/markets", label: "Markets", icon: Compass },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/leaderboard", label: "Ranks", icon: Trophy },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/wallet", label: "Wallet", icon: Wallet },
] as const;

function isActive(location: string, href: string) {
  if (href === "/markets") return location === "/markets" || location.startsWith("/market/");
  return location === href || location.startsWith(`${href}/`);
}

export function Navbar() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { user, isLoading, openLogin, logout, isAdmin } = useAuth();

  const { data: portfolio } = useQuery<Portfolio>({
    queryKey: ["/api/portfolio"],
    enabled: !!user,
    staleTime: 30_000,
  });

  // Keep the search box in sync with ?q= while browsing markets.
  const [q, setQ] = useState(() => new URLSearchParams(search).get("q") ?? "");
  useEffect(() => {
    if (location !== "/markets") return;
    setQ(new URLSearchParams(search).get("q") ?? "");
  }, [location, search]);

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/markets?q=${encodeURIComponent(term)}` : "/markets");
  };

  const portfolioValue = portfolio?.totalValue ?? (user ? user.balance : 0);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:gap-4">
          <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Foresight home">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-base font-black text-primary-foreground">
              F
            </span>
            <span className="hidden text-lg font-bold tracking-tight sm:block">Foresight</span>
          </Link>

          <form onSubmit={submitSearch} role="search" className="relative min-w-0 flex-1 md:mx-2 md:max-w-md lg:max-w-lg">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search markets"
              aria-label="Search markets"
              enterKeyHint="search"
              className="h-10 w-full rounded-lg border border-transparent bg-muted pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
            />
          </form>

          <nav className="hidden items-center gap-0.5 md:flex" aria-label="Primary">
            {NAV_LINKS.map(({ href, label, icon: Icon }) => {
              const active = isActive(location, href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {isLoading ? (
              <>
                <Skeleton className="hidden h-9 w-24 sm:block" />
                <Skeleton className="h-9 w-9 rounded-full" />
              </>
            ) : user ? (
              <>
                <Link
                  href="/portfolio"
                  className="hidden flex-col items-end rounded-lg px-2 py-1 leading-tight transition-colors hover:bg-accent lg:flex"
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Portfolio</span>
                  <span className="text-sm font-semibold tabular">{usd(portfolioValue)}</span>
                </Link>
                <Link
                  href="/wallet"
                  className="hidden flex-col items-end rounded-lg px-2 py-1 leading-tight transition-colors hover:bg-accent sm:flex"
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Cash</span>
                  <span className="text-sm font-semibold tabular text-yes">{usd(user.balance)}</span>
                </Link>
                <Button asChild size="sm" className="rounded-lg font-semibold">
                  <Link href="/wallet">Deposit</Link>
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Account menu"
                      className="flex items-center gap-1 rounded-full p-0.5 transition-colors hover:bg-accent data-[state=open]:bg-accent"
                    >
                      <UserAvatar seed={user.avatarSeed} name={user.username} size={32} />
                      <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60 rounded-xl">
                    <DropdownMenuLabel className="flex items-center gap-3 py-2.5">
                      <UserAvatar seed={user.avatarSeed} name={user.username} size={36} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">@{user.username}</div>
                        <div className="truncate text-xs font-normal text-muted-foreground">{user.email}</div>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href="/portfolio" className="flex cursor-pointer items-center gap-2">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1">Portfolio</span>
                        <span className="text-xs tabular text-muted-foreground">{usd(portfolioValue)}</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/wallet" className="flex cursor-pointer items-center gap-2">
                        <Wallet className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1">Wallet</span>
                        <span className="text-xs tabular text-yes">{usd(user.balance)}</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/create" className="flex cursor-pointer items-center gap-2">
                        <PlusCircle className="h-4 w-4 text-muted-foreground" />
                        My markets
                      </Link>
                    </DropdownMenuItem>
                    {isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin" className="flex cursor-pointer items-center gap-2">
                          <Shield className="h-4 w-4 text-muted-foreground" />
                          Admin
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="cursor-pointer">
                      <ThemeToggle variant="switch" />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                      onSelect={() => void logout()}
                    >
                      <LogOut className="h-4 w-4" />
                      Log out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="rounded-lg font-semibold" onClick={openLogin}>
                  Log In
                </Button>
                <Button size="sm" className="rounded-lg font-semibold" onClick={openLogin}>
                  Sign Up
                </Button>
                <ThemeToggle className="hidden sm:inline-flex" />
              </>
            )}
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {MOBILE_TABS.map(({ href, label, icon: Icon }) => {
          const active = isActive(location, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
