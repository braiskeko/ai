import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Flame,
  GraduationCap,
  Lightbulb,
  PlusCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
  BadgeCheck,
  type LucideIcon,
} from "lucide-react";
import type { CoinSummary, ExternalToken, TraderRank } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { BalanceHeader } from "@/components/BalanceHeader";
import { CoinCardSkeleton } from "@/components/CoinCard";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useLiveEvent, useRecentlyCreatedIds } from "@/lib/useLive";
import { compactUsd, priceUsd, shortCa, signedPct, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Sort = "new" | "trending" | "mcap" | "volume" | "graduated";

/**
 * One list, whatever the origin: coins launched on Next and every other Solana token the
 * aggregator knows about are merged and ranked together.
 */
interface Row {
  key: string;
  href: string;
  image: string | null;
  title: string;
  fallback: string;
  marketCapUsd: number;
  priceUsd: number;
  change24h: number;
  volumeUsd: number;
  createdAt: string | null;
  verified: boolean;
  /** launched here, so it can carry the launchpad badge */
  own: boolean;
  coinId?: number;
}

const SORTS: { key: Sort; labelKey: string; icon: LucideIcon }[] = [
  { key: "new", labelKey: "home.sort.new", icon: Sparkles },
  { key: "trending", labelKey: "home.sort.trending", icon: Flame },
  { key: "mcap", labelKey: "home.sort.mcap", icon: BarChart3 },
  { key: "volume", labelKey: "home.sort.volume", icon: TrendingUp },
  { key: "graduated", labelKey: "home.sort.graduated", icon: GraduationCap },
];
const SORT_KEYS = new Set<string>(SORTS.map((s) => s.key));

/** The aggregator offers three orderings; the rest are ranked client-side after merging. */
const EXTERNAL_LISTS: Partial<Record<Sort, "trending" | "top" | "new">> = {
  trending: "trending",
  volume: "top",
  new: "new",
};
const LIST_LIMIT = 60;

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

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
      className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 py-3 sm:mx-0 sm:px-0"
      role="tablist"
      aria-label={ariaLabel}
    >
      <span
        aria-hidden
        className="grid h-9 w-10 shrink-0 place-items-center rounded-xl border border-border text-muted-foreground"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </span>
      {options.map(({ key, labelKey }) => {
        const active = key === sort;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "tap h-9 shrink-0 rounded-xl px-4 text-sm transition-colors",
              active ? "bg-accent font-bold text-foreground" : "bg-secondary/60 font-medium text-muted-foreground",
            )}
          >
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekly top trades — the horizontal strip of the best performing traders
// ---------------------------------------------------------------------------

function TopTraders() {
  const t = useT();
  const solUsd = useSolUsd();
  const { data } = useQuery<TraderRank[]>({ queryKey: ["/api/traders?range=7d"], staleTime: 60_000 });
  const traders = (data ?? []).filter((x) => x.pnlSol > 0).slice(0, 10);
  if (traders.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2.5 flex items-center gap-2 text-lg font-bold tracking-tight">
        <Lightbulb className="h-4 w-4 text-muted-foreground" />
        {t("home.topTrades")}
      </h2>
      <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {traders.map((trader) => {
          const name = trader.user?.username ?? shortCa(trader.wallet);
          const token = trader.topTokens[0];
          return (
            <Link
              key={trader.wallet}
              href={trader.user ? `/u/${trader.user.username}` : "/people"}
              className="tap w-[19rem] shrink-0 overflow-hidden rounded-2xl border border-border"
            >
              <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                <UserAvatar seed={trader.user?.avatarSeed ?? trader.wallet} name={name} size={28} />
                <span className="truncate text-[15px] font-semibold">{name}</span>
              </div>
              <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2.5">
                {token ? (
                  <img src={token.imageUrl} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-full bg-muted object-cover" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded-full bg-muted" />
                )}
                <span className="truncate text-[15px] font-bold tabular text-up">
                  +{compactUsd(trader.pnlSol * solUsd)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Scope switch: coins launched here vs. every other Solana token
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// External token feed row (same look as CoinCard's "row" variant)
// ---------------------------------------------------------------------------

function TokenRow({
  href,
  image,
  title,
  marketCapUsd,
  priceUsd: price,
  change24h,
  verified,
  highlight,
  fallback,
}: {
  href: string;
  image: string | null;
  title: string;
  marketCapUsd: number;
  priceUsd: number;
  change24h: number;
  verified?: boolean;
  highlight?: boolean;
  fallback: string;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const up = change24h >= 0;
  return (
    <Link
      href={href}
      className={cn(
        "tap flex items-center gap-3 py-3.5 transition-colors",
        highlight && "animate-in fade-in slide-in-from-top-2 duration-500",
      )}
    >
      <span className="relative shrink-0">
        {image && !failed ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-12 w-12 rounded-full bg-muted object-cover"
          />
        ) : (
          <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-sm font-black text-muted-foreground">
            {fallback.slice(0, 2)}
          </span>
        )}
        {verified && (
          <BadgeCheck
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background text-primary"
            aria-label={t("token.verified")}
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-bold leading-tight">{title}</span>
        <span className="mt-0.5 block truncate text-[15px] text-muted-foreground tabular">
          {compactUsd(marketCapUsd)} {t("home.mc")}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span className="block text-[17px] font-bold leading-tight tabular">{priceUsd(price)}</span>
        {Number.isFinite(change24h) && change24h !== 0 && (
          <span className={cn("mt-0.5 block text-[15px] font-semibold tabular", up ? "text-up" : "text-down")}>
            {up ? "▲" : "▼"} {signedPct(Math.abs(change24h))}
          </span>
        )}
      </span>
    </Link>
  );
}

/** The "Solana" feed: external tokens from `/api/tokens`. */
function rowFromCoin(coin: CoinSummary, solUsd: number): Row {
  return {
    key: `next:${coin.ca}`,
    href: `/${coin.ca}`,
    image: coin.imageUrl,
    title: coin.name,
    fallback: coin.ticker,
    marketCapUsd: coin.marketCapSol * solUsd,
    priceUsd: coin.priceSol * solUsd,
    change24h: coin.change24h,
    volumeUsd: coin.volumeSol * solUsd,
    createdAt: coin.createdAt,
    verified: false,
    own: true,
    coinId: coin.id,
  };
}

function rowFromToken(token: ExternalToken): Row {
  return {
    key: `sol:${token.mint}`,
    href: `/t/${token.mint}`,
    image: token.icon,
    title: token.symbol.toUpperCase(),
    fallback: token.symbol,
    marketCapUsd: token.marketCapUsd,
    priceUsd: token.priceUsd,
    change24h: token.change24h,
    volumeUsd: token.volume24hUsd,
    createdAt: token.createdAt,
    verified: token.verified,
    own: false,
  };
}

/** Rank the merged list the way the active chip asks for. */
function rankRows(rows: Row[], sort: Sort): Row[] {
  const byTime = (a: Row, b: Row) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "");
  switch (sort) {
    case "new":
      return rows.slice().sort(byTime);
    case "mcap":
      return rows.slice().sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    case "volume":
      return rows.slice().sort((a, b) => b.volumeUsd - a.volumeUsd);
    case "trending":
      // Volume relative to size: what is moving, not merely what is large.
      return rows.slice().sort((a, b) => b.volumeUsd / (b.marketCapUsd || 1) - a.volumeUsd / (a.marketCapUsd || 1));
    case "graduated":
      return rows.slice().sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const t = useT();
  const solUsd = useSolUsd();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const q = (params.get("q") ?? "").trim();
  const rawSort = params.get("sort") ?? "";
  const sort: Sort = SORT_KEYS.has(rawSort) ? (rawSort as Sort) : "trending";

  const setSort = (next: Sort) => {
    const p = new URLSearchParams(search);
    if (next === "trending") p.delete("sort");
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
  const coinsKey = useMemo(() => {
    const p = new URLSearchParams();
    if (sort !== "new") p.set("sort", sort);
    if (q) p.set("q", q);
    p.set("limit", String(LIST_LIMIT));
    return `/api/coins?${p.toString()}`;
  }, [sort, q]);

  const tokensKey = useMemo(() => {
    const p = new URLSearchParams();
    p.set("list", EXTERNAL_LISTS[sort] ?? "trending");
    if (q) p.set("q", q);
    p.set("limit", String(LIST_LIMIT));
    return `/api/tokens?${p.toString()}`;
  }, [sort, q]);

  const coins = useQuery<CoinSummary[]>({ queryKey: [coinsKey], staleTime: 30_000 });
  // Graduated is a launchpad-only notion, so the aggregator is not asked for it.
  const tokens = useQuery<ExternalToken[]>({ queryKey: [tokensKey], staleTime: 30_000, enabled: sort !== "graduated" });
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

  const rows = useMemo(() => {
    const own = (coins.data ?? []).map((c) => rowFromCoin(c, solUsd));
    const external = (tokens.data ?? []).map(rowFromToken);
    return rankRows([...own, ...external], sort);
  }, [coins.data, tokens.data, solUsd, sort]);

  const loading = coins.isLoading || (tokens.isLoading && sort !== "graduated");
  const failed = coins.isError && (tokens.isError || sort === "graduated");

  return (
    <PageShell wide>
      <div className="space-y-5">
        <BalanceHeader />

        <TopTraders />

        <section>
          {q && (
            <div className="mb-3 flex items-center justify-between gap-3">
              <h1 className="min-w-0 truncate text-lg font-bold">{t("home.searchResults", { q })}</h1>
              <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={clearSearch}>
                <X className="h-3.5 w-3.5" />
                {t("home.clearSearch")}
              </Button>
            </div>
          )}

          <SortPills sort={sort} onChange={setSort} ariaLabel={t("home.sortBy")} />

          <div>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => <CoinCardSkeleton key={i} variant="row" />)
            ) : failed ? (
              <EmptyState
                title={t("home.loadError")}
                hint={apiErrorMessage(coins.error, t("common.error"))}
                action={
                  <Button
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      void coins.refetch();
                      void tokens.refetch();
                    }}
                  >
                    <RefreshCw className={cn("h-4 w-4", coins.isFetching && "animate-spin")} />
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : rows.length === 0 ? (
              q ? (
                <EmptyState
                  title={t("home.noResults", { q })}
                  hint={t("home.noResultsHint")}
                  action={
                    <Button variant="outline" className="rounded-full" onClick={clearSearch}>
                      <X className="h-4 w-4" />
                      {t("home.clearSearch")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
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
              rows.map((row) => (
                <TokenRow
                  key={row.key}
                  href={row.href}
                  image={row.image}
                  title={row.title}
                  marketCapUsd={row.marketCapUsd}
                  priceUsd={row.priceUsd}
                  change24h={row.change24h}
                  verified={row.verified}
                  highlight={row.coinId !== undefined && recent.has(row.coinId)}
                  fallback={row.fallback}
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
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <h2 className="text-lg font-bold">{title}</h2>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
