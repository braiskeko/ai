import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ClipboardPaste, Search as SearchIcon } from "lucide-react";
import type { CoinSummary, ExternalToken, TraderRank } from "@shared/schema";
import type { Chain } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { ChainBadge } from "@/components/ChainIcon";
import { LiveNumber } from "@/components/LiveNumber";
import { TokenImage } from "@/components/TokenImage";
import { TraderRow, TraderStripCard } from "@/components/TraderCard";
import { useT } from "@/i18n";
import { age, compactUsd, priceUsd, signedPct, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Chip = "all" | "tokens" | "traders";
const RECENTS_KEY = "nx_search_recents";
const MAX_RECENTS = 12;

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveRecents(list: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* storage unavailable */
  }
}

/** Wallets the viewer has recently looked at in search, newest first (this browser only). */
function useRecentTraderWallets() {
  const [wallets, setWallets] = useState<string[]>(loadRecents);
  const add = (wallet: string) => {
    setWallets((prev) => {
      const next = [wallet, ...prev.filter((w) => w !== wallet)].slice(0, MAX_RECENTS);
      saveRecents(next);
      return next;
    });
  };
  const remove = (wallet: string) => {
    setWallets((prev) => {
      const next = prev.filter((w) => w !== wallet);
      saveRecents(next);
      return next;
    });
  };
  const clear = () => {
    setWallets([]);
    saveRecents([]);
  };
  return { wallets, add, remove, clear };
}

// ---------------------------------------------------------------------------
// One merged row shape for our own coins and external Solana tokens
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  href: string;
  name: string;
  ticker: string;
  imageUrl: string | null;
  priceUsd: number;
  change24h: number;
  marketCapUsd: number;
  source: "next" | "solana";
  /** which chain the token lives on (ours are Solana) */
  chain: Chain;
}

function fromCoin(c: CoinSummary, solUsd: number): Row {
  return {
    key: `n${c.id}`,
    href: `/${c.ca}`,
    name: c.name,
    ticker: c.ticker,
    imageUrl: c.imageUrl,
    priceUsd: c.priceSol * solUsd,
    change24h: c.change24h,
    marketCapUsd: c.marketCapSol * solUsd,
    source: "next",
    chain: "solana",
  };
}
function fromToken(t: ExternalToken): Row {
  return {
    key: t.id,
    href: `/t/${t.id}`,
    name: t.name,
    ticker: t.symbol,
    imageUrl: t.icon,
    priceUsd: t.priceUsd,
    change24h: t.change24h,
    marketCapUsd: t.marketCapUsd,
    source: "solana",
    chain: t.chain,
  };
}

function ResultRow({ row }: { row: Row }) {
  const t = useT();
  return (
    // The whole row is the link (an absolutely positioned overlay link sits *under* the
    // content on touch devices, so the first tap lands on a child and does nothing).
    <div className="flex items-center gap-3 px-4 transition-colors hover:bg-accent/40">
      <Link href={row.href} aria-label={row.name} className="tap flex min-w-0 flex-1 items-center gap-3 py-3">
        <TokenImage src={row.imageUrl} name={row.ticker} size={48} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-bold uppercase leading-tight">{row.ticker}</span>
            {row.source === "next" ? (
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
                {t("search.badgeNext")}
              </span>
            ) : (
              <ChainBadge chain={row.chain} />
            )}
          </span>
          <span className="block truncate text-xs uppercase text-muted-foreground">
            {compactUsd(row.marketCapUsd)} {t("coin.mcap")}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <LiveNumber value={row.priceUsd} className="stat block text-sm leading-tight">
            {priceUsd(row.priceUsd)}
          </LiveNumber>
          {row.change24h !== 0 ? (
            <LiveNumber
              value={row.change24h}
              className={cn("block text-[11px] font-semibold tabular", row.change24h >= 0 ? "text-up" : "text-down")}
            >
              {signedPct(row.change24h)}
            </LiveNumber>
          ) : (
            <span className="block text-[11px] text-muted-foreground">·</span>
          )}
        </span>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SearchPage() {
  const t = useT();
  const solUsd = useSolUsd();
  const search = useSearch();
  const [chip, setChip] = useState<Chip>("all");
  const [q, setQ] = useState(() => new URLSearchParams(search).get("q") ?? "");
  const recents = useRecentTraderWallets();

  const trimmed = q.trim();
  useEffect(() => {
    document.title = `${t("search.title")} · ${t("app.name")}`;
  }, [t]);

  const coinsKey = trimmed ? `/api/coins?q=${encodeURIComponent(trimmed)}&limit=40` : "/api/coins?sort=trending&limit=20";
  const tokensKey = trimmed ? `/api/tokens?q=${encodeURIComponent(trimmed)}&limit=40` : "/api/tokens?list=trending&limit=20";

  // Live, like the home board: prices and percentages move without a reload.
  const coins = useQuery<CoinSummary[]>({
    queryKey: [coinsKey],
    staleTime: 8_000,
    refetchInterval: 12_000,
    enabled: chip !== "traders",
  });
  const tokens = useQuery<ExternalToken[]>({
    queryKey: [tokensKey],
    staleTime: 8_000,
    refetchInterval: 12_000,
    enabled: chip !== "traders",
  });
  const traders = useQuery<TraderRank[]>({ queryKey: ["/api/traders?range=all&limit=150"], staleTime: 30_000 });

  const rows = useMemo<Row[]>(
    () => [...(coins.data ?? []).map((c) => fromCoin(c, solUsd)), ...(tokens.data ?? []).map(fromToken)],
    [coins.data, tokens.data, solUsd],
  );

  const filteredTraders = useMemo<TraderRank[]>(() => {
    const list = traders.data ?? [];
    if (!trimmed) return list;
    const needle = trimmed.toLowerCase();
    return list.filter(
      (r) => (r.user?.username.toLowerCase().includes(needle) ?? false) || r.wallet.toLowerCase().includes(needle),
    );
  }, [traders.data, trimmed]);

  const recentTraders = useMemo(() => {
    const byWallet = new Map((traders.data ?? []).map((r) => [r.wallet, r] as const));
    return recents.wallets.map((w) => byWallet.get(w)).filter((r): r is TraderRank => !!r);
  }, [recents.wallets, traders.data]);

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setQ(text.trim());
    } catch {
      /* clipboard unavailable or denied — leave the field as-is */
    }
  };

  const showTokens = chip === "all" || chip === "tokens";
  const showTraders = chip === "all" || chip === "traders";
  const loading = (showTokens && (coins.isLoading || tokens.isLoading)) || (chip === "traders" && traders.isLoading);
  const nothingFound = !loading && (!showTokens || rows.length === 0) && (!showTraders || filteredTraders.length === 0);

  const SearchField = ({ className, autoFocus }: { className?: string; autoFocus?: boolean }) => (
    <div className={cn("flex items-center gap-2 rounded-full border border-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur", className)}>
      <SearchIcon className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("search.placeholder")}
        aria-label={t("search.placeholder")}
        spellCheck={false}
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={() => void pasteFromClipboard()}
        className="tap inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-bold text-foreground"
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        {t("search.paste")}
      </button>
    </div>
  );

  return (
    <PageShell noFooter className="pt-3 pb-32 md:pt-6 md:pb-10">
      {/* Outside the stack: on mobile the field lives at the bottom, and a hidden first
          child would still push the chips down by the stack's gap. */}
      <SearchField className="mx-auto mb-5 hidden max-w-2xl md:flex" />

      <div className="mx-auto max-w-2xl space-y-5">
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label={t("search.title")}>
          {(
            [
              ["all", t("search.chipAll")],
              ["tokens", t("search.chipTokens")],
              ["traders", t("search.chipTraders")],
            ] as [Chip, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={chip === key}
              onClick={() => setChip(key)}
              className={cn(
                "tap h-9 shrink-0 rounded-full border px-4 text-sm font-bold transition-colors",
                chip === key ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {recentTraders.length > 0 && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-muted-foreground">{t("search.recents")}</h2>
              <button type="button" onClick={recents.clear} className="text-sm font-semibold text-primary">
                {t("search.clearAll")}
              </button>
            </div>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {recentTraders.map((tr) => (
                <TraderStripCard key={tr.wallet} trader={tr} onRemove={() => recents.remove(tr.wallet)} />
              ))}
            </div>
          </section>
        )}

        <section className="space-y-1">
          {loading ? (
            <div className="space-y-2" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-1 py-2">
                  <div className="h-12 w-12 animate-pulse rounded-2xl bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : nothingFound ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">🔍</div>
              <h2 className="mt-4 text-lg font-bold">{t("search.noResults")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("search.noResultsHint")}</p>
            </div>
          ) : (
            <>
              {showTokens && (
                <ul className="feed-divide">
                  {rows.map((row) => (
                    <li key={row.key}>
                      <ResultRow row={row} />
                    </li>
                  ))}
                </ul>
              )}
              {showTraders && filteredTraders.length > 0 && (
                <div className={showTokens ? "mt-4" : undefined}>
                  {chip === "all" && <h2 className="mb-1 px-1 text-sm font-bold text-muted-foreground">{t("search.chipTraders")}</h2>}
                  <ul className="feed-divide">
                    {filteredTraders.slice(0, chip === "all" ? 8 : undefined).map((tr) => (
                      <li key={tr.wallet} onClick={() => recents.add(tr.wallet)}>
                        <TraderRow trader={tr} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Floating pill search field, mobile only — sits just above the bottom tab bar. */}
      <div className="fixed inset-x-0 bottom-[calc(5.4rem+env(safe-area-inset-bottom,0px))] z-30 px-4 md:hidden">
        <SearchField className="mx-auto max-w-md" />
      </div>
    </PageShell>
  );
}
