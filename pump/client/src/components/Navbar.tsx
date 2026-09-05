import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Activity,
  Briefcase,
  ChevronDown,
  Home,
  LogOut,
  PlusCircle,
  Search,
  Shield,
  Sparkles,
  User as UserIcon,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { usd } from "@/lib/format";
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

const MOBILE_TABS = [
  { href: "/", key: "nav.home", icon: Home },
  { href: "/create", key: "nav.create", icon: PlusCircle },
  { href: "/activity", key: "nav.activity", icon: Activity },
  { href: "/portfolio", key: "nav.portfolio", icon: Briefcase },
  { href: "/wallet", key: "nav.wallet", icon: Wallet },
] as const;

/** Same shape check as server/ca.ts isValidCa (44 base58 chars ending in "noxia"). */
export const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{39}noxia$/;
export const looksLikeCa = (s: string) => CA_RE.test(s);

function isActive(location: string, href: string) {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}

export function Navbar() {
  const t = useT();
  const config = useConfig();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { user, isLoading, openLogin, logout, isAdmin } = useAuth();
  const appName = config?.appName ?? t("app.name");

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
      navigate(`/${term}`);
      return;
    }
    navigate(term ? `/?q=${encodeURIComponent(term)}` : "/");
  };

  const avatarSeed = user?.avatarUrl ?? user?.avatarSeed ?? "";

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-16 w-full max-w-screen-2xl items-center gap-2 px-4 sm:gap-3">
          <Link href="/" className="flex shrink-0 items-center gap-2" aria-label={t("nav.homeAria", { app: appName })}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-base font-black text-primary-foreground shadow-[0_0_18px_-4px_hsl(var(--primary)/0.8)]">
              N
            </span>
            <span className="hidden text-lg font-bold tracking-tight sm:block">{appName}</span>
          </Link>

          <form onSubmit={submitSearch} role="search" className="relative min-w-0 flex-1 md:mx-2 md:max-w-sm lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("nav.search")}
              aria-label={t("nav.search")}
              enterKeyHint="search"
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-transparent bg-muted pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
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
                <Link
                  href="/wallet"
                  className="hidden flex-col items-end rounded-lg px-2 py-1 leading-tight transition-colors hover:bg-accent sm:flex"
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("nav.cash")}</span>
                  <span className="text-sm font-semibold tabular text-primary">{usd(user.balance)}</span>
                </Link>
                <Button asChild size="sm" variant="outline" className="hidden rounded-lg font-semibold sm:inline-flex">
                  <Link href="/wallet">{t("nav.deposit")}</Link>
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("nav.account")}
                      className="flex items-center gap-1 rounded-full p-0.5 transition-colors hover:bg-accent data-[state=open]:bg-accent"
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
                        <span className="text-xs tabular text-primary">{usd(user.balance)}</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/u/${user.username}`} className="flex cursor-pointer items-center gap-2">
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
                <Button variant="ghost" size="sm" className="rounded-lg font-semibold" onClick={openLogin}>
                  {t("nav.login")}
                </Button>
                <Button size="sm" className="rounded-lg font-semibold" onClick={openLogin}>
                  {t("nav.signup")}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Earn banner for viewports where the header pill does not fit */}
        <Link
          href="/create"
          className="flex items-center justify-center gap-2 border-t border-primary/20 bg-primary/10 px-4 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 lg:hidden"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("header.earn")}</span>
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">
            {t("nav.create")}
          </span>
        </Link>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label={t("nav.mobile")}
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {MOBILE_TABS.map(({ href, key, icon: Icon }) => {
          const active = isActive(location, href);
          const isCreate = href === "/create";
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
              <Icon className={cn("h-5 w-5", isCreate && "text-primary")} />
              <span className="truncate">{t(key)}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
