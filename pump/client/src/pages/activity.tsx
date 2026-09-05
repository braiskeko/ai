import { useCallback, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Activity as ActivityIcon, ArrowDownRight, ArrowUpRight, RefreshCw, Sparkles, type LucideIcon } from "lucide-react";
import type { ActivityItem, CoinSummary, PublicUser } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { LiveDot } from "@/components/Footer";
import { PublicAvatar } from "@/components/TradesTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { useLiveEvent, useLiveTrades } from "@/lib/useLive";
import { compactUsd, priceUsd, timeAgo, tokens as fmtTokens, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Feed model: trades (from /api/activity + socket) and coin launches (from the
// newest-first coin list + socket) merged into a single timeline.
// ---------------------------------------------------------------------------

type Filter = "all" | "buys" | "sells" | "created";

interface CoinRef {
  id: number;
  ca: string;
  name: string;
  ticker: string;
  imageUrl: string;
}

type FeedItem =
  | { kind: "trade"; key: string; at: number; user: PublicUser; coin: CoinRef; side: "buy" | "sell"; usdc: number; tokens: number; price: number }
  | { kind: "created"; key: string; at: number; user: PublicUser; coin: CoinRef; marketCap: number };

const ACTIVITY_KEY = "/api/activity?limit=60";
const COINS_KEY = "/api/coins?limit=60";
const FEED_LIMIT = 120;
const LIVE_CREATED_CAP = 60;

const FILTERS: { key: Filter; labelKey: string; icon: LucideIcon }[] = [
  { key: "all", labelKey: "activity.filter.all", icon: ActivityIcon },
  { key: "buys", labelKey: "activity.filter.buys", icon: ArrowUpRight },
  { key: "sells", labelKey: "activity.filter.sells", icon: ArrowDownRight },
  { key: "created", labelKey: "activity.filter.created", icon: Sparkles },
];

const coinRef = (c: CoinRef): CoinRef => ({ id: c.id, ca: c.ca, name: c.name, ticker: c.ticker, imageUrl: c.imageUrl });

function tradeItem(trade: ActivityItem["trade"], user: PublicUser, coin: CoinRef): FeedItem {
  return {
    kind: "trade",
    key: `t${trade.id}`,
    at: Date.parse(trade.createdAt),
    user,
    coin: coinRef(coin),
    side: trade.side,
    usdc: trade.usdc,
    tokens: trade.tokens,
    price: trade.price,
  };
}

function createdItem(coin: CoinSummary): FeedItem {
  return { kind: "created", key: `c${coin.id}`, at: Date.parse(coin.createdAt), user: coin.creator, coin: coinRef(coin), marketCap: coin.marketCap };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function FeedRow({ item, isNew }: { item: FeedItem; isNew: boolean }) {
  const t = useT();
  const { user: me } = useAuth();
  const mine = !!me && me.id === item.user.id;
  const name = mine ? t("chart.you") : `@${item.user.username}`;

  const tone = item.kind === "created" ? "created" : item.side;
  const flash = tone === "buy" ? "rgba(34,197,94,0.16)" : tone === "sell" ? "rgba(244,63,94,0.16)" : "rgba(167,139,250,0.18)";

  return (
    <motion.li
      layout="position"
      initial={isNew ? { opacity: 0, y: -16, backgroundColor: flash } : false}
      animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-3 border-b border-border p-3 transition-colors last:border-b-0 hover:bg-accent/40 sm:p-4"
    >
      <Link href={`/u/${encodeURIComponent(item.user.username)}`} className="shrink-0" aria-label={name}>
        <PublicAvatar user={item.user} size={36} />
      </Link>

      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <Link href={`/u/${encodeURIComponent(item.user.username)}`} className="font-semibold hover:underline">
            {name}
          </Link>{" "}
          {item.kind === "created" ? (
            <span className="font-medium text-violet">{t("activity.created")}</span>
          ) : (
            <>
              <span className={cn("font-medium", item.side === "buy" ? "text-up" : "text-down")}>
                {item.side === "buy" ? t("activity.bought") : t("activity.sold")}
              </span>{" "}
              <span className="tabular font-semibold">{compactUsd(item.usdc)}</span> <span className="text-muted-foreground">{t("activity.of")}</span>
            </>
          )}{" "}
          <Link href={`/${item.coin.ca}`} className="inline-flex max-w-full items-center gap-1 align-middle font-bold hover:underline">
            <img src={item.coin.imageUrl} alt="" loading="lazy" className="h-4 w-4 rounded-sm bg-muted object-cover" />
            <span className="truncate">{item.coin.name}</span>
            <span className="text-xs font-semibold text-muted-foreground">${item.coin.ticker}</span>
          </Link>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground tabular">
          {item.kind === "created" ? (
            <>
              {t("coin.mcap")} {compactUsd(item.marketCap)}
            </>
          ) : (
            <>
              {fmtTokens(item.tokens)} {item.coin.ticker} · {t("trades.price")} {priceUsd(item.price)}
            </>
          )}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {item.kind === "created" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet/15 px-2 py-0.5 text-[11px] font-bold text-violet">
            <Sparkles className="h-3 w-3" />
            {t("common.new")}
          </span>
        ) : (
          <div className={cn("tabular text-sm font-semibold", item.side === "buy" ? "text-up" : "text-down")}>
            {item.side === "buy" ? "+" : "-"}
            {usd(item.usdc)}
          </div>
        )}
        <div className="mt-0.5 text-xs text-muted-foreground" title={new Date(item.at).toLocaleString()}>
          {timeAgo(new Date(item.at))}
        </div>
      </div>
    </motion.li>
  );
}

function FeedSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" aria-hidden>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border p-4 last:border-b-0">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <ActivityIcon className="h-5 w-5" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ActivityPage() {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("all");

  const activity = useQuery<ActivityItem[]>({ queryKey: [ACTIVITY_KEY], staleTime: 15_000 });
  const coins = useQuery<CoinSummary[]>({ queryKey: [COINS_KEY], staleTime: 30_000 });
  const liveTrades = useLiveTrades(FEED_LIMIT);

  // Coins launched while this page is open (the coin list cache is patched too, but this
  // keeps their arrival order and lets us mark them as fresh).
  const [liveCreated, setLiveCreated] = useState<CoinSummary[]>([]);
  const [freshKeys, setFreshKeys] = useState<Set<string>>(() => new Set());
  const onCreated = useCallback((coin: CoinSummary) => {
    setLiveCreated((prev) => (prev.some((c) => c.id === coin.id) ? prev : [coin, ...prev].slice(0, LIVE_CREATED_CAP)));
    setFreshKeys((prev) => new Set(prev).add(`c${coin.id}`));
  }, []);
  useLiveEvent("coin:created", onCreated);

  const liveTradeKeys = useMemo(() => new Set(liveTrades.map((x) => `t${x.trade.id}`)), [liveTrades]);

  const items = useMemo<FeedItem[]>(() => {
    const byKey = new Map<string, FeedItem>();
    for (const { coin, trade } of liveTrades) byKey.set(`t${trade.id}`, tradeItem(trade, trade.user, coin));
    for (const a of activity.data ?? []) {
      const key = `t${a.trade.id}`;
      if (!byKey.has(key)) byKey.set(key, tradeItem(a.trade, a.user, a.coin));
    }
    for (const c of liveCreated) byKey.set(`c${c.id}`, createdItem(c));
    for (const c of coins.data ?? []) {
      const key = `c${c.id}`;
      if (!byKey.has(key)) byKey.set(key, createdItem(c));
    }
    return Array.from(byKey.values())
      .sort((a, b) => b.at - a.at)
      .slice(0, FEED_LIMIT);
  }, [liveTrades, activity.data, liveCreated, coins.data]);

  const visible = useMemo(() => {
    switch (filter) {
      case "buys":
        return items.filter((i) => i.kind === "trade" && i.side === "buy");
      case "sells":
        return items.filter((i) => i.kind === "trade" && i.side === "sell");
      case "created":
        return items.filter((i) => i.kind === "created");
      default:
        return items;
    }
  }, [items, filter]);

  const loading = activity.isLoading && coins.isLoading;
  const failed = activity.isError && coins.isError;
  const refetch = () => {
    void activity.refetch();
    void coins.refetch();
  };
  const fetching = activity.isFetching || coins.isFetching;

  return (
    <PageShell>
      <div className="mx-auto max-w-3xl">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{t("activity.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("activity.subtitle", { app: t("app.name") })}</p>
          </div>
          <div className="flex items-center gap-2">
            <LiveDot />
            <button
              type="button"
              onClick={refetch}
              aria-label={t("activity.refresh")}
              title={t("activity.refresh")}
              className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", fetching && "animate-spin")} />
            </button>
          </div>
        </header>

        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="tablist" aria-label={t("activity.title")}>
          {FILTERS.map(({ key, labelKey, icon: Icon }) => {
            const active = key === filter;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(key)}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors",
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

        {loading ? (
          <FeedSkeleton />
        ) : failed ? (
          <Empty
            title={t("activity.loadError")}
            body={apiErrorMessage(activity.error ?? coins.error, t("common.error"))}
            action={
              <Button variant="outline" className="rounded-lg" onClick={refetch}>
                <RefreshCw className={cn("h-4 w-4", fetching && "animate-spin")} />
                {t("common.retry")}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <Empty title={t("activity.empty")} body={t("activity.emptyHint")} />
        ) : visible.length === 0 ? (
          <Empty title={t("activity.emptyFilter")} />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            <AnimatePresence initial={false}>
              {visible.map((item) => (
                <FeedRow key={item.key} item={item} isNew={liveTradeKeys.has(item.key) || freshKeys.has(item.key)} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </PageShell>
  );
}
