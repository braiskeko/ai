import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * TradingView's advanced chart, for symbols TradingView actually carries.
 *
 * It is a renderer, not a data source: its catalogue covers the majors a perp
 * market is written on (BTC, ETH, SOL…) but not a memecoin minted an hour ago,
 * which is why the token pages keep their own chart fed by real OHLCV. When the
 * script cannot load — offline, blocked, an unknown symbol — `onUnavailable`
 * fires so the caller can fall back rather than leave a hole in the page.
 */

const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";
const SCRIPT_ID = "tradingview-tv-js";

declare global {
  interface Window {
    TradingView?: { widget: new (options: Record<string, unknown>) => unknown };
  }
}

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.TradingView) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("tradingview script failed")), { once: true });
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export interface TradingViewChartProps {
  /** A TradingView symbol, e.g. "BINANCE:BTCUSDT" or "CRYPTO:SOLUSD". */
  symbol: string;
  /** TradingView interval code: 1, 5, 15, 60, 240, D. */
  interval?: string;
  height?: number;
  className?: string;
  onUnavailable?: () => void;
}

export function TradingViewChart({ symbol, interval = "60", height = 380, className, onUnavailable }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `tv_${Math.random().toString(36).slice(2)}`;
    const el = containerRef.current;
    if (el) el.id = id;

    loadScript()
      .then(() => {
        if (cancelled || !window.TradingView || !el) return;
        new window.TradingView.widget({
          container_id: id,
          symbol,
          interval,
          autosize: true,
          theme: "dark",
          style: "1",
          locale: "en",
          hide_top_toolbar: true,
          hide_legend: false,
          allow_symbol_change: false,
          save_image: false,
          backgroundColor: "rgba(0,0,0,0)",
          gridColor: "rgba(255,255,255,0.06)",
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        onUnavailable?.();
      });

    return () => {
      cancelled = true;
      if (el) el.innerHTML = "";
    };
    // The widget is imperative: rebuild it when the symbol or interval changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  if (failed) return null;
  return <div ref={containerRef} className={cn("w-full overflow-hidden rounded-2xl", className)} style={{ height }} />;
}

/**
 * The TradingView symbol for a perp market, or null when it carries none — a
 * builder-deployed market has no counterpart there.
 */
export function tradingViewSymbol(perp: string): string | null {
  const bare = perp.replace(/^[a-z]+:/i, "").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(bare)) return null;
  return `CRYPTO:${bare}USD`;
}

export default TradingViewChart;
