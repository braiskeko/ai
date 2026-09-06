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
  BadgeCheck,
  Droplets,
  type LucideIcon,
} from "lucide-react";
import type { CoinSummary, ExternalToken, PlatformStats } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard, CoinCardSkeleton } from "@/components/CoinCard";
import { LiveTicker } from "@/components/LiveTicker";
import { Button } from "@/components/ui/button";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useLiveEvent, useRecentlyCreatedIds } from "@/lib/useLive";
import { age, compactUsd, priceUsd, signedPct, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Sort = "new" | "trending" | "mcap" | "volume" | "graduated";
/** "next" = coins launched here; "solana" = every other token, via the aggregator. */
type Scope = "next" | "solana";

const SORTS: { key: Sort; labelKey: string; icon: LucideIcon }[] = [
  { key: "new", labelKey: "home.sort.new", icon: Sparkles },
  { key: "trending", labelKey: "home.sort.trending", icon: Flame },
  { key: "mcap", labelKey: "home.sort.mcap", icon: BarChart3 },
  { key: "volume", labelKey: "home.sort.volume", icon: TrendingUp },
  { key: "graduated", labelKey: "home.sort.graduated", icon: GraduationCap },
];
const SORT_KEYS = new Set<string>(SORTS.map((s) => s.key));

/**
 * The aggregator only offers three orderings, so the Solana scope shows the
 * three sort pills that map onto them and defaults to trending.
 */
const EXTERNAL_LISTS: Partial<Record<Sort, "trending" | "top" | "new">> = {
  trending: "trending",
  volume: "top",
  new: "new",
};
const EXTERNAL_SORTS = SORTS.filter((s) => s.key in EXTERNAL_LISTS);
const DEFAULT_EXTERNAL_SORT: Sort = "trending";
const LIST_LIMIT = 60;

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

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

function SortPills({
  sort,
  onChange,
  ariaLabel,
  options = SORTS,
}: {
  sort: Sort;
  onChange: (s: Sort) => void;
  ariaLabel: string;
  options?: typeof SORTS;
}) {
  const t = useT();
  return (
    <div
      className="no-scrollbar sticky top-14 z-20 -mx-4 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:px-0"
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map(({ key, labelKey, icon: Icon }) => {
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
// Scope switch: coins launched here vs. every other Solana token
// ---------------------------------------------------------------------------

function ScopeSwitch({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  const t = useT();
  const options: { key: Scope; label: string }[] = [
    { key: "next", label: t("home.scope.next") },
    { key: "solana", label: t("home.scope.solana") },
  ];
  return (
    <div
      className="inline-flex rounded-full border border-border bg-card p-1"
      role="tablist"
      aria-label={t("home.scope.aria")}
    >
      {options.map(({ key, label }) => {
        const active = key === scope;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "tap h-9 rounded-full px-4 text-sm font-bold transition-colors",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// External token feed row (same look as CoinCard's "row" variant)
// ---------------------------------------------------------------------------

function ExternalTokenRow({ token }: { token: ExternalToken }) {
  const t = useT();
  const [, navigate] = useLocation();
  const [iconFailed, setIconFailed] = useState(false);
  const href = `/t/${token.mint}`;

  return (
    <div className="group feed-row tap">
      <Link href={href} aria-label={t("coin.openCoin", { name: token.name })} className="absolute inset-0" />
      {token.icon && !iconFailed ? (
        <img
          src={token.icon}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setIconFailed(true)}
          className="relative h-14 w-14 shrink-0 rounded-2xl bg-muted object-cover"
        />
      ) : (
        <div className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-muted text-base font-black text-muted-foreground">
          {token.symbol.slice(0, 2)}
        </div>
      )}

      <div className="relative min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="truncate font-bold leading-tight">{token.name}</span>
          <span className="shrink-0 text-xs font-semibold text-muted-foreground">${token.symbol}</span>
          {token.verified && (
            <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={t("token.verified")} />
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="tabular">{priceUsd(token.priceUsd)}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5" title={t("token.liquidity")}>
            <Droplets className="h-3 w-3" />
            {compactUsd(token.liquidityUsd)}
          </span>
          {token.holders > 0 && (
            <span className="hidden shrink-0 items-center gap-0.5 sm:inline-flex" title={t("coin.holders")}>
              <Users className="h-3 w-3" />
              {count(token.holders)}
            </span>
          )}
          {token.createdAt && <span className="hidden shrink-0 sm:inline">· {age(token.createdAt)}</span>}
        </div>
      </div>

      <div className="relative flex shrink-0 items-center gap-2">
        <div className="text-right">
          <div className="stat text-base leading-tight text-foreground">{compactUsd(token.marketCapUsd)}</div>
          {Number.isFinite(token.change24h) && token.change24h !== 0 ? (
            <div className={cn("text-[11px] font-semibold tabular", token.change24h >= 0 ? "text-up" : "text-down")}>
              {signedPct(token.change24h)}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground">·</div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate(href);
          }}
          className="tap inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3 text-xs font-bold text-primary-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          {t("trade.buy")}
        </button>
      </div>
    </div>
  );
}

/** The "Solana" feed: external tokens from `/api/tokens`. */
function ExternalFeed({ sort, q }: { sort: Sort; q: string }) {
  const t = useT();
  const listKey = useMemo(() => {
    const p = new URLSearchParams();
    p.set("list", EXTERNAL_LISTS[sort] ?? "trending");
    if (q) p.set("q", q);
    p.set("limit", String(LIST_LIMIT));
    return `/api/tokens?${p.toString()}`;
  }, [sort, q]);

  const tokens = useQuery<ExternalToken[]>({ queryKey: [listKey], staleTime: 30_000 });
  const list = tokens.data ?? [];

  if (tokens.isLoading) {
    return (
      <>
        {Array.from({ length: 8 }).map((_, i) => (
          <CoinCardSkeleton key={i} variant="row" />
        ))}
      </>
    );
  }
  if (tokens.isError) {
    return (
      <EmptyState
        emoji="😵"
        title={t("home.external.unavailable")}
        hint={apiErrorMessage(tokens.error, t("home.external.unavailableHint"))}
        action={
          <Button variant="outline" className="rounded-full" onClick={() => void tokens.refetch()}>
            <RefreshCw className={cn("h-4 w-4", tokens.isFetching && "animate-spin")} />
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  if (list.length === 0) {
    // An empty answer means either "nothing matched" or "the aggregator is
    // unreachable" — the server degrades both to []. Say so honestly.
    return (
      <EmptyState
        emoji={q ? "🔍" : "📡"}
        title={q ? t("home.noResults", { q }) : t("home.external.unavailable")}
        hint={q ? t("home.external.searchHint") : t("home.external.unavailableHint")}
        action={
          <Button variant="outline" className="rounded-full" onClick={() => void tokens.refetch()}>
            <RefreshCw className={cn("h-4 w-4", tokens.isFetching && "animate-spin")} />
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  return (
    <>
      {list.map((token) => (
        <ExternalTokenRow key={token.mint} token={token} />
      ))}
    </>
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
  // The scope lives in the URL (?scope=solana) so it survives reloads and sharing.
  const scope: Scope = params.get("scope") === "solana" ? "solana" : "next";
  const external = scope === "solana";
  const rawSort = params.get("sort") ?? "";
  const defaultSort: Sort = external ? DEFAULT_EXTERNAL_SORT : "new";
  const allowedSort = external ? rawSort in EXTERNAL_LISTS : SORT_KEYS.has(rawSort);
  const sort: Sort = allowedSort ? (rawSort as Sort) : defaultSort;

  const setSort = (next: Sort) => {
    const p = new URLSearchParams(search);
    if (next === defaultSort) p.delete("sort");
    else p.set("sort", next);
    const qs = p.toString();
    navigate(qs ? `/?${qs}` : "/", { replace: true });
  };
  const setScope = (next: Scope) => {
    const p = new URLSearchParams(search);
    if (next === "solana") p.set("scope", "solana");
    else p.delete("scope");
    // Sort vocabularies differ between the two feeds; start each at its default.
    p.delete("sort");
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

  const coins = useQuery<CoinSummary[]>({ queryKey: [listKey], staleTime: 30_000, enabled: !external });
  const recent = useRecentlyCreatedIds();

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
                {q ? t("home.searchResults", { q }) : external ? t("home.external.title") : t("home.title")}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {q
                  ? external || coins.data
                    ? external
                      ? t("home.external.searchHint")
                      : t("home.resultsCount", { n: count(list.length) })
                    : t("common.loading")
                  : external
                    ? t("home.external.subtitle")
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
            </div>
          </div>

          <div className="mt-3">
            <ScopeSwitch scope={scope} onChange={setScope} />
          </div>

          <SortPills
            sort={sort}
            onChange={setSort}
            ariaLabel={t("home.sortBy")}
            options={external ? EXTERNAL_SORTS : SORTS}
          />

          <div className="surface feed-divide mt-3 overflow-hidden">
            {external ? (
              <ExternalFeed sort={sort} q={q} />
            ) : coins.isLoading ? (
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
                    <div className="flex flex-wrap justify-center gap-2">
                      {/* Nothing of ours matched — offer the same search across every Solana token. */}
                      <Button className="rounded-full font-semibold" onClick={() => setScope("solana")}>
                        <Search className="h-4 w-4" />
                        {t("home.external.searchAll")}
                      </Button>
                      <Button variant="outline" className="rounded-full" onClick={clearSearch}>
                        <X className="h-4 w-4" />
                        {t("home.clearSearch")}
                      </Button>
                    </div>
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
                  highlight={recent.has(coin.id)}
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
