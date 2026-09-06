import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  ChevronDown,
  Home,
  LogOut,
  PlusCircle,
  Search,
  Shield,
  Sparkles,
  User as UserIcon,
  Users,
  Wallet,
} from "lucide-react";
import type { WalletView } from "@shared/schema";
import { SOLANA_ADDRESS_RE } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { getQueryFn } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { LanguageSwitcher, useT } from "@/i18n";
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

/** A search term that looks like a mint address (shared/schema.ts SOLANA_ADDRESS_RE). */
export const looksLikeCa = (s: string) => SOLANA_ADDRESS_RE.test(s);

/** "Ab12…9f3c" — kept local; lib/format.ts (shortCa) is owned by another agent. */
function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = Math.abs(n).toFixed(3).replace(/\.?0+$/, "");
  return (n < 0 ? "-" : "") + (s || "0");
}

function isActive(location: string, href: string) {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}

export function Navbar({ hideTabs = false }: { hideTabs?: boolean } = {}) {
  const t = useT();
  const config = useConfig();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { user, isLoading, openLogin, logout, isAdmin } = useAuth();
  const appName = config?.appName ?? t("app.name");
  const walletLinked = !!user?.walletAddress;

  const { data: walletView } = useQuery<WalletView | null>({
    queryKey: ["/api/wallet"],
    queryFn: getQueryFn<WalletView | null>({ on401: "returnNull" }),
    enabled: walletLinked,
    staleTime: 15_000,
  });

  // Keep the search box in sync with ?q= while browsing the home list.
  const [q, setQ] = useState(() => new URLSearchParams(search).get("q") ?? "");
  useEffect(() => {
    if (location !== "/") return;
    setQ(new URLSearchParams(search).get("q") ?? "");
  }, [location, search]);

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (looksLikeCa(term)) {
      // Our own coins win; the coin page offers the external token when the
      // mint was not launched here (see pages/coin.tsx).
      navigate(`/${term}`);
      return;
    }
    // Keep whichever feed the user is browsing (?scope=solana searches all of Solana).
    const params = new URLSearchParams();
    if (new URLSearchParams(search).get("scope") === "solana" && location === "/") params.set("scope", "solana");
    if (term) params.set("q", term);
    const qs = params.toString();
    navigate(qs ? `/?${qs}` : "/");
  };

  const avatarSeed = user?.avatarUrl ?? user?.avatarSeed ?? "";

  return (
    <>
      <header className="sticky top-0 z-40 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-12 w-full max-w-screen-2xl items-center gap-2 px-4 sm:h-14 sm:gap-3">
          <Link href="/" className="flex shrink-0 items-center" aria-label={t("nav.homeAria", { app: appName })}>
            <span className="wordmark text-2xl leading-none">{appName.toLowerCase()}</span>
          </Link>

          {/* Search stays in the header on desktop; mobile reaches it via the bottom-bar Search tab (pages/search.tsx). */}
          <form onSubmit={submitSearch} role="search" className="relative hidden min-w-0 md:mx-2 md:block md:max-w-sm lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("nav.search")}
              aria-label={t("nav.search")}
              enterKeyHint="search"
              spellCheck={false}
              className="h-10 w-full rounded-full border border-transparent bg-muted pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
            />
          </form>

          {/* Header CTA: earn pill + create button */}
          <div className="hidden items-center gap-2 lg:flex">
            <Link
              href="/create"
              title={t("header.earnHint")}
              className="group inline-flex h-10 items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3.5 text-sm font-semibold text-primary transition-colors hover:border-primary/70 hover:bg-primary/15"
            >
              <Sparkles className="h-4 w-4 transition-transform group-hover:rotate-12" />
              <span className="whitespace-nowrap">{t("header.earn")}</span>
            </Link>
            <Button asChild className="h-10 rounded-full px-4 font-bold shadow-[0_0_20px_-6px_hsl(var(--primary)/0.9)]">
              <Link href="/create">
                <PlusCircle className="h-4 w-4" />
                {t("nav.create")}
              </Link>
            </Button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle className="hidden sm:inline-flex" />
            {isLoading ? (
              <>
                <Skeleton className="hidden h-9 w-24 sm:block" />
                <Skeleton className="h-9 w-9 rounded-full" />
              </>
            ) : user ? (
              <>
                {walletLinked ? (
                  <Link
                    href="/wallet"
                    className="hidden flex-col items-end rounded-lg px-2 py-1 leading-tight transition-colors hover:bg-accent sm:flex"
                  >
                    <span className="label">
                      {shortAddr(user.walletAddress!)}
                    </span>
                    <span className="text-sm font-semibold tabular text-primary">{fmtSol(walletView?.balanceSol ?? 0)} SOL</span>
                  </Link>
                ) : (
                  <Button size="sm" variant="outline" className="hidden rounded-lg font-semibold sm:inline-flex" onClick={openLogin}>
                    <Wallet className="h-4 w-4" />
                    {t("nav.connect")}
                  </Button>
                )}

                {/* Desktop only: on mobile the bottom bar's Profile tab is the way in. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("nav.account")}
                      className="hidden items-center gap-1 rounded-full p-0.5 transition-colors hover:bg-accent data-[state=open]:bg-accent sm:flex"
                    >
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <UserAvatar seed={avatarSeed} name={user.username} size={32} />
                      )}
                      <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64 rounded-xl">
                    <DropdownMenuLabel className="flex items-center gap-3 py-2.5">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
                      ) : (
                        <UserAvatar seed={avatarSeed} name={user.username} size={36} />
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">@{user.username}</div>
                        <div className="truncate text-xs font-normal text-muted-foreground">
                          {user.provider === "wallet" && user.walletAddress ? user.walletAddress : user.email}
                        </div>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href="/portfolio" className="flex cursor-pointer items-center gap-2">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1">{t("nav.portfolio")}</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/wallet" className="flex cursor-pointer items-center gap-2">
                        <Wallet className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1">{t("nav.wallet")}</span>
                        {walletLinked ? (
                          <span className="text-xs tabular text-primary">{fmtSol(walletView?.balanceSol ?? 0)} SOL</span>
                        ) : (
                          <span className="text-xs font-medium text-primary">{t("nav.connect")}</span>
                        )}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/${user.username}`} className="flex cursor-pointer items-center gap-2">
                        <UserIcon className="h-4 w-4 text-muted-foreground" />
                        {t("nav.profile")}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/create" className="flex cursor-pointer items-center gap-2">
                        <PlusCircle className="h-4 w-4 text-muted-foreground" />
                        {t("nav.create")}
                      </Link>
                    </DropdownMenuItem>
                    {isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin" className="flex cursor-pointer items-center gap-2">
                          <Shield className="h-4 w-4 text-muted-foreground" />
                          {t("nav.admin")}
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="cursor-pointer">
                      <ThemeToggle variant="switch" />
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="cursor-pointer p-0 sm:hidden">
                      <LanguageSwitcher variant="row" />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                      onSelect={() => void logout()}
                    >
                      <LogOut className="h-4 w-4" />
                      {t("nav.logout")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="hidden rounded-lg font-semibold sm:inline-flex" onClick={openLogin}>
                  {t("nav.login")}
                </Button>
                <Button size="sm" className="hidden rounded-lg font-semibold sm:inline-flex" onClick={openLogin}>
                  {t("nav.signup")}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Earn banner for viewports where the header pill does not fit */}
        <Link
          href="/create"
          className="hidden items-center justify-center gap-2 border-t border-primary/20 bg-primary/10 px-4 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 sm:flex lg:hidden"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("header.earn")}</span>
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">
            {t("nav.create")}
          </span>
        </Link>
      </header>

      {!hideTabs && <MobileTabs />}
    </>
  );
}

/** The floating bottom tab bar — rendered on its own by header-less pages. */
export function MobileTabs() {
  const t = useT();
  const [location] = useLocation();
  const { user } = useAuth();
  const mobileTabs = [
    { href: "/", key: "nav.home", icon: Home },
    { href: "/search", key: "nav.search", icon: Search },
    { href: "/create", key: "nav.create", icon: PlusCircle, brand: true },
    { href: "/people", key: "nav.people", icon: Users },
    { href: "/profile", key: "nav.profile", icon: UserIcon, avatar: true },
  ] as const;

  return (
      <nav
        aria-label={t("nav.mobile")}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden"
      >
        <div className="pointer-events-auto flex w-full max-w-md items-center justify-around rounded-full border border-white/5 bg-secondary/80 px-1.5 py-1.5 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          {mobileTabs.map((tab) => {
            const active = isActive(location, tab.href);
            const Icon = tab.icon;
            const showAvatar = "avatar" in tab && tab.avatar && user;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-label={t(tab.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "tap grid h-11 w-14 place-items-center rounded-full transition-colors",
                  active ? "bg-white/10 text-foreground" : "text-muted-foreground",
                )}
              >
                {showAvatar ? (
                  <span className={cn("rounded-full", active && "ring-2 ring-foreground/70")}>
                    <UserAvatar seed={user.avatarSeed} name={user.username} size={26} />
                  </span>
                ) : (
                  <Icon
                    className={cn(
                      "h-[22px] w-[22px]",
                      "brand" in tab && tab.brand && "h-7 w-7",
                      active && "text-foreground",
                    )}
                    strokeWidth={active ? 2.4 : 2}
                  />
                )}
              </Link>
            );
          })}
        </div>
      </nav>
  );
}
