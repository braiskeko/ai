import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import type { PerpCategory, PerpMarket } from "@shared/schema";
import { TokenImage } from "@/components/TokenImage";
import { useT } from "@/i18n";
import { compactUsd, priceUsd, signedPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Perpetual markets, busiest first, from Hyperliquid (server/hyperliquid.ts).
 *
 * Read-only for now: the list, the leverage each market allows and what it has
 * done today. Placing an order needs the account's EVM key to sign Hyperliquid's
 * typed-data actions and margin bridged there, which is its own step — so this
 * says what it is rather than showing a Buy button that would not work.
 */

const CATEGORIES: (PerpCategory | "all")[] = ["all", "crypto", "stocks", "commodities", "indices"];

export function PerpsList() {
  const t = useT();
  const [category, setCategory] = useState<PerpCategory | "all">("all");
  const perps = useQuery<PerpMarket[]>({ queryKey: ["/api/perps?limit=120"], staleTime: 20_000, refetchInterval: 30_000 });

  const all = perps.data ?? [];
  const shown = useMemo(
    () => (category === "all" ? all : all.filter((m) => m.category === category)),
    [all, category],
  );
  // Only offer a category that actually has markets today.
  const available = useMemo(() => {
    const present = new Set(all.map((m) => m.category));
    return CATEGORIES.filter((c) => c === "all" || present.has(c as PerpCategory));
  }, [all]);

  return (
    <div>
      {available.length > 2 && (
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-3 sm:mx-0 sm:px-0" role="tablist">
          {available.map((key) => {
            const active = key === category;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(key)}
                className={cn(
                  "tap h-9 shrink-0 rounded-xl px-4 text-sm transition-colors",
                  active ? "bg-accent font-bold text-foreground" : "bg-secondary/60 font-medium text-muted-foreground",
                )}
              >
                {t(`perps.category.${key}`)}
              </button>
            );
          })}
        </div>
      )}

      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-border px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-up">
          <TrendingUp className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-bold leading-tight">{t("perps.promoTitle")}</div>
          <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{t("perps.promoHint")}</div>
        </div>
      </div>

      {perps.isLoading ? (
        <div className="space-y-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <div className="h-11 w-11 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-1/4 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <h2 className="text-lg font-bold">{t("perps.empty")}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("perps.emptyHint")}</p>
        </div>
      ) : (
        <ul>
          {shown.map((market) => {
            const up = market.change24h >= 0;
            return (
              <li key={market.symbol} className="flex items-center gap-3 py-3.5">
                {/* Hyperliquid publishes no logos, so the ticker's initials stand in. */}
                <TokenImage src={null} name={market.symbol} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[17px] font-bold leading-tight">{market.symbol}</span>
                    <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                      {market.maxLeverage}x
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[15px] text-muted-foreground tabular">
                    {compactUsd(market.volume24hUsd)} {t("perps.vol")}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[17px] font-bold leading-tight tabular">{priceUsd(market.priceUsd)}</div>
                  <div className={cn("mt-0.5 text-[15px] font-semibold tabular", up ? "text-up" : "text-down")}>
                    {up ? "▲" : "▼"} {signedPct(Math.abs(market.change24h))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PerpsList;
