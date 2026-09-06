import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Coins,
  Flame,
  GraduationCap,
  PlusCircle,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CoinSummary, PlatformStats } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard, CoinCardSkeleton } from "@/components/CoinCard";
import { LiveTicker } from "@/components/LiveTicker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useLiveEvent, useRecentlyCreatedIds } from "@/lib/useLive";
import { compactUsd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Sort = "new" | "trending" | "mcap" | "volume" | "graduated";

const SORTS: { key: Sort; labelKey: string; icon: LucideIcon }[] = [
  { key: "new", labelKey: "home.sort.new", icon: Sparkles },
  { key: "trending", labelKey: "home.sort.trending", icon: Flame },
  { key: "mcap", labelKey: "home.sort.mcap", icon: BarChart3 },
  { key: "volume", labelKey: "home.sort.volume", icon: TrendingUp },
  { key: "graduated", labelKey: "home.sort.graduated", icon: GraduationCap },
];
const SORT_KEYS = new Set<string>(SORTS.map((s) => s.key));
const LIST_LIMIT = 60;
const ANIMATIONS_KEY = "nx_animations";

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

function loadAnimations(): boolean {
  try {
    return localStorage.getItem(ANIMATIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stats strip — a compact horizontal scroller of pill-shaped tiles
// ---------------------------------------------------------------------------

function StatsStrip() {
  const t = useT();
  const solUsd = useSolUsd();
  const { data, isLoading } = useQuery<PlatformStats>({ queryKey: ["/api/stats"], staleTime: 30_000 });

  const tiles: { key: string; icon: LucideIcon; value: string | null }[] = [
    { key: "home.stats.coins", icon: Coins, value: data ? count(data.coins) : null },
    { key: "home.stats.volume", icon: TrendingUp, value: data ? compactUsd(data.volumeSol * solUsd) : null },
    { key: "home.stats.traders", icon: Users, value: data ? count(data.traders) : null },
    { key: "home.stats.trades", icon: Activity, value: data ? count(data.trades) : null },
  ];

  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-4 sm:gap-3 sm:px-0">
      {tiles.map(({ key, icon: Icon, value }) => (
        <div
          key={key}
          className="surface flex shrink-0 items-center gap-2.5 px-3.5 py-2.5 sm:shrink"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="label whitespace-nowrap">{t(key)}</div>
            {isLoading || value === null ? (
              <div className="mt-1 h-4 w-14 animate-pulse rounded bg-muted" />
            ) : (
              <div className="truncate text-sm font-bold leading-tight tabular">{value}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sticky filter pills
// ---------------------------------------------------------------------------

function SortPills({ sort, onChange, ariaLabel }: { sort: Sort; onChange: (s: Sort) => void; ariaLabel: string }) {
  const t = useT();
  return (
    <div
      className="no-scrollbar sticky top-14 z-20 -mx-4 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:px-0"
      role="tablist"
      aria-label={ariaLabel}
    >
      {SORTS.map(({ key, labelKey, icon: Icon }) => {
        const active = key === sort;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "tap inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors",
              active
                ? "border-primary bg-primary/15 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const t = useT();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const q = (params.get("q") ?? "").trim();
  const rawSort = params.get("sort") ?? "new";
  const sort: Sort = SORT_KEYS.has(rawSort) ? (rawSort as Sort) : "new";

  const setSort = (next: Sort) => {
    const p = new URLSearchParams(search);
    if (next === "new") p.delete("sort");
    else p.set("sort", next);
    const qs = p.toString();
    navigate(qs ? `/?${qs}` : "/", { replace: true });
  };
  const clearSearch = () => {
    const p = new URLSearchParams(search);
    p.delete("q");
    const qs = p.toString();
    navigate(qs ? `/?${qs}` : "/");
  };

  // Key shape matters: lib/useLive prepends live coins into "newest first" lists (sort=new, no search).
  const listKey = useMemo(() => {
    const p = new URLSearchParams();
    if (sort !== "new") p.set("sort", sort);
    if (q) p.set("q", q);
    p.set("limit", String(LIST_LIMIT));
    return `/api/coins?${p.toString()}`;
  }, [sort, q]);

  const coins = useQuery<CoinSummary[]>({ queryKey: [listKey], staleTime: 30_000 });
  const recent = useRecentlyCreatedIds();

  const [animations, setAnimations] = useState<boolean>(loadAnimations);
  useEffect(() => {
    try {
      localStorage.setItem(ANIMATIONS_KEY, animations ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [animations]);

  // "New coin!" toast for coins launched by other people while we are browsing.
  const onCreated = useCallback(
    (coin: CoinSummary) => {
      if (user && coin.creatorId === user.id) return;
      toast({
        title: `🚀 ${t("home.newCoin")}`,
        description: t("home.feed.created", { user: `@${coin.creator.username}`, ticker: `${coin.name} ($${coin.ticker})` }),
      });
    },
    [user, toast, t],
  );
  useLiveEvent("coin:created", onCreated);

  const list = coins.data ?? [];

  return (
    <PageShell wide>
      <div className="space-y-5">
        <LiveTicker />

        <StatsStrip />

        <section>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">
                {q ? t("home.searchResults", { q }) : t("home.title")}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {q
                  ? coins.data
                    ? t("home.resultsCount", { n: count(list.length) })
                    : t("common.loading")
                  : t("home.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {q && (
                <Button variant="outline" size="sm" className="rounded-full" onClick={clearSearch}>
                  <X className="h-3.5 w-3.5" />
                  {t("home.clearSearch")}
                </Button>
              )}
              <label className="hidden items-center gap-2 text-xs text-muted-foreground sm:inline-flex">
                <Switch checked={animations} onCheckedChange={setAnimations} aria-label={t("home.animations")} />
                {t("home.animations")}
              </label>
            </div>
          </div>

          <SortPills sort={sort} onChange={setSort} ariaLabel={t("home.sortBy")} />

          <div className="surface feed-divide mt-3 overflow-hidden">
            {coins.isLoading ? (
              Array.from({ length: 8 }).map((_, i) => <CoinCardSkeleton key={i} variant="row" />)
            ) : coins.isError ? (
              <EmptyState
                emoji="😵"
                title={t("home.loadError")}
                hint={apiErrorMessage(coins.error, t("common.error"))}
                action={
                  <Button variant="outline" className="rounded-full" onClick={() => void coins.refetch()}>
                    <RefreshCw className={cn("h-4 w-4", coins.isFetching && "animate-spin")} />
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : list.length === 0 ? (
              q ? (
                <EmptyState
                  emoji="🔍"
                  title={t("home.noResults", { q })}
                  hint={t("home.noResultsHint")}
                  action={
                    <Button variant="outline" className="rounded-full" onClick={clearSearch}>
                      <Search className="h-4 w-4" />
                      {t("home.clearSearch")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  emoji="🚀"
                  title={t("home.empty")}
                  hint={t("app.tagline")}
                  action={
                    <Button asChild className="rounded-full font-semibold">
                      <Link href="/create">
                        <PlusCircle className="h-4 w-4" />
                        {t("nav.create")}
                      </Link>
                    </Button>
                  }
                />
              )
            ) : (
              list.map((coin) => (
                <CoinCard
                  key={coin.id}
                  coin={coin}
                  variant="row"
                  highlight={animations && recent.has(coin.id)}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function EmptyState({
  emoji,
  title,
  hint,
  action,
}: {
  emoji: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">{emoji}</div>
      <h2 className="mt-4 text-lg font-bold">{title}</h2>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
