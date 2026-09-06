import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { PerpDetail } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CandleChart, type ChartRange } from "@/components/CandleChart";
import { TokenImage } from "@/components/TokenImage";
import { WatchButton } from "@/components/WatchButton";
import { TradingViewChart, tradingViewSymbol } from "@/components/TradingViewChart";
import { Skeleton } from "@/components/ui/skeleton";
import NotFound from "@/pages/not-found";
import { useT } from "@/i18n";
import { perpLogo } from "@/components/PerpsList";
import { compactUsd, priceUsd, signedPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One perpetual market: what it costs, what it has done today, and its chart.
 *
 * The chart is TradingView where TradingView carries the symbol, and our own
 * candles — the real ones from Hyperliquid — everywhere else and whenever their
 * script cannot load.
 */
export default function PerpPage() {
  const t = useT();
  const { symbol = "" } = useParams<{ symbol: string }>();
  const market = useQuery<PerpDetail>({
    queryKey: [`/api/perps/${encodeURIComponent(symbol)}`],
    enabled: symbol.length > 0,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: (count, err) => !(err instanceof Error && /^404:/.test(err.message)) && count < 2,
  });

  const [range, setRange] = useState<ChartRange>("4H");
  const [tvDown, setTvDown] = useState(false);
  const tvSymbol = useMemo(() => (symbol ? tradingViewSymbol(symbol) : null), [symbol]);

  const data = market.data;
  useEffect(() => {
    if (!data) return;
    const prev = document.title;
    document.title = `${data.symbol} · ${t("perps.title")} · ${t("app.name")}`;
    return () => {
      document.title = prev;
    };
  }, [data, t]);

  if (market.isError && market.error instanceof Error && /^404:/.test(market.error.message)) {
    return <NotFound title={t("perps.notFound")} hint={t("perps.notFoundHint")} />;
  }

  return (
    <PageShell wide noHeader className="pt-4 pb-nav-actions md:pb-10">
      {!data ? (
        <div className="space-y-4">
          <Skeleton className="h-12 w-52" />
          <Skeleton className="h-[380px] w-full rounded-3xl" />
        </div>
      ) : (
        <div className="space-y-6">
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <Link href="/?board=perps" aria-label={t("common.back")} className="tap -ml-1 shrink-0 text-muted-foreground">
                <ChevronLeft className="h-6 w-6" />
              </Link>
              <TokenImage src={perpLogo(data.symbol)} name={data.symbol} size={44} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-[22px] font-extrabold leading-tight tracking-tight">{data.symbol}</h1>
                  <span
                    className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-bold text-primary"
                    title={t("perps.maxLeverage", { max: String(data.maxLeverage) })}
                  >
                    {data.maxLeverage}x
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">{t("perps.onHyperliquid")}</div>
              </div>
              <WatchButton id={`perp:${data.symbol}`} />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[40px] font-extrabold leading-none tracking-tight tabular">{priceUsd(data.priceUsd)}</div>
                <div
                  className={cn(
                    "mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[15px] font-semibold tabular",
                    data.change24h >= 0 ? "text-up" : "text-down",
                  )}
                >
                  <span className="align-[0.15em] text-[9px]">{data.change24h >= 0 ? "▲" : "▼"}</span>
                  {signedPct(data.change24h)}
                  <span className="font-medium text-muted-foreground">24h</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[26px] font-bold leading-tight tabular">{compactUsd(data.volume24hUsd)}</div>
                <div className="text-sm text-muted-foreground">{t("perps.vol24h")}</div>
              </div>
            </div>
          </section>

          {tvSymbol && !tvDown ? (
            <TradingViewChart symbol={tvSymbol} interval="60" height={380} onUnavailable={() => setTvDown(true)} />
          ) : (
            <CandleChart
              candles={data.candles}
              trades={[]}
              ticker={data.symbol}
              unit="USD"
              mode="price"
              modeSwitch={false}
              range={range}
              onRangeChange={setRange}
              className="-mx-4 sm:mx-0 sm:rounded-3xl sm:border sm:border-border sm:bg-card"
            />
          )}

          <section className="surface divide-y divide-border p-4">
            <Row label={t("perps.vol24h")} value={compactUsd(data.volume24hUsd)} />
            <Row label={t("perps.openInterest")} value={compactUsd(data.openInterestUsd)} />
            <Row
              label={t("perps.funding")}
              value={`${(data.fundingRate * 100).toFixed(4)}%`}
              valueClass={data.fundingRate >= 0 ? "text-up" : "text-down"}
            />
            <Row label={t("perps.leverage")} value={`${data.maxLeverage}x`} />
          </section>

          <p className="px-1 text-sm text-muted-foreground">{t("perps.tradingSoon")}</p>
        </div>
      )}
    </PageShell>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tabular", valueClass)}>{value}</span>
    </div>
  );
}
