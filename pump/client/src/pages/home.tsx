import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Flame,
  GraduationCap,
  PlusCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingUp,
  X,
  BadgeCheck,
  type LucideIcon,
} from "lucide-react";
import type { Chain, CoinSummary, ExternalToken } from "@shared/schema";
import { CHAINS } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { BalanceHeader } from "@/components/BalanceHeader";
import { CoinCardSkeleton } from "@/components/CoinCard";
import { ChainBadge } from "@/components/ChainIcon";
import { LiveNumber } from "@/components/LiveNumber";
import { PerpsList } from "@/components/PerpsList";
import { TokenImage } from "@/components/TokenImage";
import { Button } from "@/components/ui/button";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useLiveEvent, useRecentlyCreatedIds } from "@/lib/useLive";
import { compactUsd, priceUsd, signedPct, useSolUsd } from "@/lib/format";
import { useWatchlist } from "@/lib/watchlist";
import { cn } from "@/lib/utils";

type Sort = "new" | "trending" | "mcap" | "volume" | "graduated";
/** The three boards the home screen offers; Tokens is what opens. */
type Board = "watchlist" | "tokens" | "perps";
const BOARDS: Board[] = ["watchlist", "tokens", "perps"];

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
  /** which chain the token lives on (ours are Solana) */
  chain: Chain;
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
  chain,
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
  chain?: Chain;
}) {
  const t = useT();
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
        <TokenImage src={image} name={fallback} size={48} />
        {verified && (
          <BadgeCheck
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background text-primary"
            aria-label={t("token.verified")}
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[17px] font-bold leading-tight">{title}</span>
          {chain && <ChainBadge chain={chain} />}
        </span>
        <span className="mt-0.5 block truncate text-[15px] text-muted-foreground tabular">
          {compactUsd(marketCapUsd)} {t("home.mc")}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <LiveNumber value={price} className="block text-[17px] font-bold leading-tight tabular">
          {priceUsd(price)}
        </LiveNumber>
        {Number.isFinite(change24h) && change24h !== 0 && (
          <LiveNumber
            value={change24h}
            className={cn("mt-0.5 block text-[15px] font-semibold tabular", up ? "text-up" : "text-down")}
          >
            <span className="mr-0.5 align-[0.15em] text-[8px]">{up ? "▲" : "▼"}</span>
            {signedPct(Math.abs(change24h))}
          </LiveNumber>
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
    chain: "solana",
    coinId: coin.id,
  };
}

function rowFromToken(token: ExternalToken): Row {
  return {
    key: token.id,
    href: `/t/${token.id}`,
    chain: token.chain,
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

/**
 * Assets that are never "trending": stablecoins sit at a dollar by design, and
 * the majors (and their wrapped and staked forms) are always the busiest thing
 * on the chain — leaving them in means the board never shows a memecoin.
 */
const NOT_TRENDING = new Set([
  // Stablecoins: a dollar is never trending.
  "USDC", "USDT", "USDS", "USDE", "USDG", "PYUSD", "DAI", "FDUSD", "EURC", "USDY", "USD1", "USDH", "SUSDE",
  // The chains' own assets and their wrapped or staked forms.
  "SOL", "WSOL", "MSOL", "JITOSOL", "BSOL", "JUPSOL", "INF", "JSOL", "HSOL",
  "ETH", "WETH", "STETH", "WSTETH", "CBETH", "RETH", "WEETH",
  "BTC", "WBTC", "CBBTC", "TBTC", "ZBTC",
  "BNB", "WBNB", "HYPE", "MON", "WMON", "AVAX", "MATIC", "POL", "ARB", "OP", "S", "SUI", "APT", "TON", "TRX", "XRP", "ADA",
  // Infrastructure and DeFi: real products, not memecoins.
  "JUP", "RAY", "ORCA", "PYTH", "JTO", "W", "TNSR", "DRIFT", "KMNO", "MPLX", "RENDER", "RNDR", "HNT", "MOBILE",
  "IOT", "IO", "GRASS", "ZEUS", "SHDW", "NOS", "PRCL", "STEP", "SBR", "MNGO", "AUDIO", "META", "CLOUD", "DBR",
  "LINK", "UNI", "AAVE", "CRV", "LDO", "MKR", "ENA", "ONDO", "PENDLE", "AERO", "CBETH", "MORPHO", "EIGEN", "ETHFI",
]);

/**
 * What "trending" means here: traded a lot in the last 24h, moving, and small
 * enough to be moving because of demand rather than because it is the chain's
 * reserve asset.
 *
 * Volume dominates on a log scale (a $10M day beats a $100K one without a
 * hundredfold gap), turnover — volume against size — rewards a coin whose whole
 * float is changing hands, and the 24h move adds momentum, bounded, because
 * +900% on no volume is noise rather than a trend.
 */
/**
 * Above this, an asset is infrastructure rather than a memecoin: majors, wrapped
 * assets and the chains' own tokens live up there, and they are not what this
 * board is for.
 */
const TRENDING_MCAP_CEILING = 5_000_000_000;
/** Below this a "trend" is one wash trade. */
const TRENDING_MIN_VOLUME = 5_000;

function trendingScore(row: Row): number {
  const volume = Math.log10(1 + Math.max(0, row.volumeUsd));
  const turnover = row.marketCapUsd > 0 ? row.volumeUsd / row.marketCapUsd : 0;
  const churn = 0.6 * Math.log10(1 + Math.min(20, turnover));
  const momentum = Math.max(-0.5, Math.min(3, row.change24h));
  return volume + churn + momentum;
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
      return rows
        .filter(
          (r) =>
            !NOT_TRENDING.has(r.fallback.toUpperCase()) &&
            r.volumeUsd >= TRENDING_MIN_VOLUME &&
            (r.marketCapUsd === 0 || r.marketCapUsd <= TRENDING_MCAP_CEILING),
        )
        .sort((a, b) => trendingScore(b) - trendingScore(a));
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
  const rawBoard = params.get("board") ?? "";
  const board: Board = (BOARDS as string[]).includes(rawBoard) ? (rawBoard as Board) : "tokens";
  const setBoard = (next: Board) => {
    const p = new URLSearchParams(search);
    if (next === "tokens") p.delete("board");
    else p.set("board", next);
    const qs = p.toString();
    navigate(qs ? `/?${qs}` : "/", { replace: true });
  };

  const rawChain = params.get("chain") ?? "";
  const chain: Chain | "all" = (CHAINS as string[]).includes(rawChain) ? (rawChain as Chain) : "all";


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
    if (chain !== "all") p.set("chain", chain);
    p.set("limit", String(LIST_LIMIT));
    return `/api/tokens?${p.toString()}`;
  }, [sort, q, chain]);

  // Live prices: the lists re-read every few seconds, and our own coins also
  // arrive over the socket the moment a trade lands.
  const coins = useQuery<CoinSummary[]>({
    queryKey: [coinsKey],
    staleTime: 8_000,
    refetchInterval: 10_000,
    enabled: chain === "all" || chain === "solana",
  });
  // Graduated is a launchpad-only notion, so the aggregator is not asked for it.
  const tokens = useQuery<ExternalToken[]>({
    queryKey: [tokensKey],
    staleTime: 8_000,
    refetchInterval: 10_000,
    enabled: sort !== "graduated",
  });
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

  const watchlist = useWatchlist();
  // Starred perps live on the same board as starred tokens.
  const starredPerps = useMemo(
    () => watchlist.ids.filter((id) => id.startsWith("perp:")).map((id) => id.slice("perp:".length)),
    [watchlist.ids],
  );
  const rows = useMemo(() => {
    const own = (coins.data ?? []).map((c) => rowFromCoin(c, solUsd));
    const external = (tokens.data ?? []).map(rowFromToken);
    const merged = rankRows([...own, ...external], sort);
    return board === "watchlist" ? merged.filter((r) => watchlist.has(r.key)) : merged;
  }, [coins.data, tokens.data, solUsd, sort, board, watchlist]);

  const loading = coins.isLoading || (tokens.isLoading && sort !== "graduated");
  const failed = coins.isError && (tokens.isError || sort === "graduated");

  return (
    <PageShell wide>
      <div className="space-y-5">
        <BalanceHeader />

        <BoardTabs board={board} onChange={setBoard} />

        {board === "perps" ? (
          <PerpsList />
        ) : (
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
            ) : rows.length === 0 && board === "watchlist" && starredPerps.length === 0 ? (
              <EmptyState title={t("home.watchlistEmpty")} hint={t("home.watchlistHint")} />
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
                <motion.div key={row.key} layout transition={{ type: "spring", stiffness: 420, damping: 38 }}>
                <TokenRow
                  href={row.href}
                  image={row.image}
                  title={row.title}
                  marketCapUsd={row.marketCapUsd}
                  priceUsd={row.priceUsd}
                  change24h={row.change24h}
                  verified={row.verified}
                  highlight={row.coinId !== undefined && recent.has(row.coinId)}
                  fallback={row.fallback}
                  chain={row.chain}
                />
                </motion.div>
              ))
            )}
            {board === "watchlist" && starredPerps.length > 0 && <PerpsList onlySymbols={starredPerps} />}
          </div>
        </section>
        )}
      </div>
    </PageShell>
  );
}

/** Watchlist · Tokens · Perps, the way the reference design splits the home screen. */
function BoardTabs({ board, onChange }: { board: Board; onChange: (b: Board) => void }) {
  const t = useT();
  return (
    <div className="flex items-center border-b border-border" role="tablist">
      {BOARDS.map((key) => {
        const active = key === board;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "tap relative -mb-px flex flex-1 items-center justify-center gap-1.5 border-b-[3px] py-3 text-[17px] transition-colors",
              active ? "border-primary font-bold text-foreground" : "border-transparent font-semibold text-muted-foreground",
            )}
          >
            {key === "watchlist" && <Star className={cn("h-[18px] w-[18px]", active && "fill-current")} />}
            {key === "watchlist" ? t("home.tabs.watchlist") : key === "tokens" ? t("home.tabs.tokens") : t("perps.title")}
            {key === "perps" && (
              <span className="rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-bold text-primary-foreground">
                {t("perps.new")}
              </span>
            )}
          </button>
        );
      })}
    </div>
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
