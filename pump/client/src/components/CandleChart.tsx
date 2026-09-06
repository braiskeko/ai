import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type UTCTimestamp,
} from "lightweight-charts";
import { motion } from "framer-motion";
import { BarChart3 } from "lucide-react";
import type { Candle, PublicUser, Trade } from "@shared/schema";
import { CANDLE_INTERVAL_MS, TOTAL_SUPPLY } from "@shared/schema";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { shortCa } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChartInterval = "1m" | "5m" | "15m" | "1h";
export type ChartMode = "price" | "mcap";
/** Denomination of the candles: our own coins are priced in SOL, external tokens in USD. */
export type ChartUnit = "SOL" | "USD";
export type LiveTrade = Trade & { user: PublicUser | null };

export interface CandleChartProps {
  /** 1-minute OHLC candles (`unit` per token). Any order; aggregated client-side. */
  candles: Candle[];
  /** Trades to draw as avatar markers (any order; only the last MAX_MARKERS are drawn). */
  trades: LiveTrade[];
  ticker: string;
  /** Currency the candle values are expressed in (default "SOL"). */
  unit?: ChartUnit;
  /**
   * Multiplier applied to every value before it is drawn — pass the SOL/USD rate
   * together with `unit="USD"` to show a SOL-priced coin in dollars (default 1).
   */
  rate?: number;
  /** Supply the "mcap" mode multiplies the price by (default: our own TOTAL_SUPPLY). */
  supply?: number;
  height?: number;
  /** Controlled mode; when omitted the chart keeps its own state (default "price"). */
  mode?: ChartMode;
  onModeChange?: (mode: ChartMode) => void;
  /** Controlled interval; when omitted the chart keeps its own state (default "1m"). */
  interval?: ChartInterval;
  onIntervalChange?: (interval: ChartInterval) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UP = "#22c55e";
const DOWN = "#f43f5e";
const UP_VOL = "rgba(34, 197, 94, 0.35)";
const DOWN_VOL = "rgba(244, 63, 94, 0.35)";

const INTERVALS: ChartInterval[] = ["1m", "5m", "15m", "1h"];
const INTERVAL_MS: Record<ChartInterval, number> = {
  "1m": CANDLE_INTERVAL_MS,
  "5m": 5 * CANDLE_INTERVAL_MS,
  "15m": 15 * CANDLE_INTERVAL_MS,
  "1h": 60 * CANDLE_INTERVAL_MS,
};

/** Only the most recent trades get an avatar marker (performance, and so the candles stay visible). */
const MAX_MARKERS = 24;
/**
 * Bars shown when the chart first draws. Fitting hundreds of one-minute bars into a phone
 * width renders every candle sub-pixel — which reads as "the chart is broken" — so the view
 * opens on a window this wide and the user can scroll or pinch out for the rest.
 */
const VISIBLE_BARS = 72;
/** Gaps between candles are filled with flat candles up to this many bars. */
const MAX_FILLED_BARS = 3000;
/** Grid cell (px) used to detect overlapping avatars; overlapping ones stack with STACK_OFFSET. */
const CLUSTER_CELL = 24;
const STACK_OFFSET = 4;

// ---------------------------------------------------------------------------
// Time helpers — lightweight-charts renders UTCTimestamps as UTC, so we shift
// every timestamp by the viewer's timezone offset to get local labels.
// ---------------------------------------------------------------------------

function tzOffsetSeconds(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60;
}
/** ms since epoch → chart time (seconds, shifted to local wall-clock). */
function toChartTime(ms: number): UTCTimestamp {
  return (Math.floor(ms / 1000) + tzOffsetSeconds(ms)) as UTCTimestamp;
}
/** chart time → real Date (inverse of toChartTime, exact except within DST transitions). */
function fromChartTime(t: number): Date {
  const approx = t * 1000;
  return new Date(approx - tzOffsetSeconds(approx) * 1000);
}

// ---------------------------------------------------------------------------
// Number formatting for the axes (kept local: the price axis needs plain,
// canvas-safe digits rather than subscript notation).
// ---------------------------------------------------------------------------

/** "0.0421 SOL" / "$0.0421" — plain digits, no subscripts (this goes on a canvas). */
function fmtAxisPrice(p: number, unit: ChartUnit = "SOL"): string {
  if (!Number.isFinite(p) || p <= 0) return withUnit("0", unit);
  if (p >= 1000) return fmtCompactAmount(p, unit);
  const decimals = p >= 1 ? 4 : p >= 0.01 ? 6 : Math.min(12, -Math.floor(Math.log10(p)) + 2);
  return withUnit(p.toFixed(decimals), unit);
}

function fmtCompactAmount(n: number, unit: ChartUnit = "SOL"): string {
  if (!Number.isFinite(n)) return withUnit("0", unit);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return withUnit(`${sign}${trimZeros((abs / 1e9).toFixed(2))}B`, unit);
  if (abs >= 1e6) return withUnit(`${sign}${trimZeros((abs / 1e6).toFixed(2))}M`, unit);
  if (abs >= 1e3) return withUnit(`${sign}${trimZeros((abs / 1e3).toFixed(1))}K`, unit);
  return withUnit(`${sign}${abs.toFixed(4)}`, unit);
}

function withUnit(value: string, unit: ChartUnit): string {
  return unit === "USD" ? `$${value}` : `${value} SOL`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trimZeros((n / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${trimZeros((n / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `${trimZeros((n / 1e3).toFixed(1))}K`;
  return trimZeros(n.toFixed(2));
}

// ---------------------------------------------------------------------------
// Aggregation: 1m candles → interval buckets, gaps filled, trailing "now" bar
// ---------------------------------------------------------------------------

function bucketStart(ms: number, intervalMs: number): number {
  return Math.floor(ms / intervalMs) * intervalMs;
}

function aggregateCandles(candles: Candle[], intervalMs: number, nowMs: number): Candle[] {
  const sorted = candles
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];

  const out: Candle[] = [];
  for (const c of sorted) {
    const t = bucketStart(c.t, intervalMs);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }

  // Trailing flat bar at the current bucket so the chart is anchored at "now".
  const nowBucket = bucketStart(Math.max(nowMs, out[out.length - 1].t), intervalMs);
  const span = (nowBucket - out[0].t) / intervalMs + 1;
  if (span <= MAX_FILLED_BARS) {
    const filled: Candle[] = [];
    let i = 0;
    let prevClose = out[0].o;
    for (let t = out[0].t; t <= nowBucket; t += intervalMs) {
      const c = out[i];
      if (c && c.t === t) {
        filled.push(c);
        prevClose = c.c;
        i++;
      } else {
        filled.push({ t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0 });
      }
    }
    return filled;
  }
  const tail = out[out.length - 1];
  if (tail.t < nowBucket) out.push({ t: nowBucket, o: tail.c, h: tail.c, l: tail.c, c: tail.c, v: 0 });
  return out;
}

/** Index of the last candle whose time is <= t (binary search), or -1. */
function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// ---------------------------------------------------------------------------
// Theme palette read from the shadcn CSS variables (reacts to the dark class)
// ---------------------------------------------------------------------------

interface Palette {
  text: string;
  grid: string;
  border: string;
  key: string;
}

function readPalette(): Palette {
  const fallback: Palette = {
    text: "#8b93a5",
    grid: "rgba(139, 147, 165, 0.12)",
    border: "rgba(139, 147, 165, 0.25)",
    key: "fallback",
  };
  if (typeof window === "undefined") return fallback;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const muted = read("--muted-foreground");
  const border = read("--border");
  if (!muted) return fallback;
  return {
    text: cssHsl(muted),
    grid: border ? cssHsl(border, 0.45) : fallback.grid,
    border: border ? cssHsl(border) : fallback.border,
    key: `${muted}|${border}`,
  };
}

/**
 * Tailwind stores HSL tokens as space-separated triplets ("222 13% 60%"). The canvas
 * color parser used by lightweight-charts understands neither HSL nor that syntax, so
 * convert the token to rgb()/rgba().
 */
function cssHsl(token: string, alpha?: number): string {
  const parts = token.replace(/\//g, " ").split(/\s+/).filter(Boolean);
  const h = parseFloat(parts[0] ?? "0") || 0;
  const sat = (parseFloat(parts[1] ?? "0") || 0) / 100;
  const light = (parseFloat(parts[2] ?? "0") || 0) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  const [r, g, b] = [f(0), f(8), f(4)];
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function useChartPalette(): Palette {
  const [palette, setPalette] = useState<Palette>(readPalette);
  useEffect(() => {
    const update = () => {
      const next = readPalette();
      setPalette((prev) => (prev.key === next.key ? prev : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

// ---------------------------------------------------------------------------
// Marker sizing
// ---------------------------------------------------------------------------

/** Deliberately small: the avatars annotate the candles, they must not hide them. */
function markerSize(sol: number): number {
  const s = 13 + 2.5 * Math.log2(1 + Math.max(0, sol) / 0.1);
  return Math.round(Math.min(24, Math.max(14, s)));
}

interface MarkerMeta {
  trade: LiveTrade;
  time: UTCTimestamp;
  /** raw bucket start in ms (for nearest-candle fallback) */
  bucketMs: number;
  value: number;
  size: number;
}

interface Placed {
  x: number;
  y: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CandleChart({
  candles,
  trades,
  ticker,
  unit = "SOL",
  rate = 1,
  supply = TOTAL_SUPPLY,
  height = 380,
  mode: modeProp,
  onModeChange,
  interval: intervalProp,
  onIntervalChange,
  className,
}: CandleChartProps) {
  const t = useT();
  const { user } = useAuth();
  const palette = useChartPalette();

  // Controlled-or-uncontrolled mode / interval.
  const [modeState, setModeState] = useState<ChartMode>(modeProp ?? "price");
  const [intervalState, setIntervalState] = useState<ChartInterval>(intervalProp ?? "1m");
  useEffect(() => {
    if (modeProp) setModeState(modeProp);
  }, [modeProp]);
  useEffect(() => {
    if (intervalProp) setIntervalState(intervalProp);
  }, [intervalProp]);
  const mode = modeProp ?? modeState;
  const interval = intervalProp ?? intervalState;
  const setMode = (m: ChartMode) => {
    setModeState(m);
    onModeChange?.(m);
  };
  const setInterval_ = (i: ChartInterval) => {
    setIntervalState(i);
    onIntervalChange?.(i);
  };

  const conversion = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const scale = (mode === "mcap" ? (supply > 0 ? supply : TOTAL_SUPPLY) : 1) * conversion;
  const intervalMs = INTERVAL_MS[interval];

  // ---- Series data ----------------------------------------------------------
  const aggregated = useMemo(() => aggregateCandles(candles, intervalMs, Date.now()), [candles, intervalMs]);

  const { candleData, volumeData, bucketTimes } = useMemo(() => {
    const candleData: CandlestickData<UTCTimestamp>[] = [];
    const volumeData: HistogramData<UTCTimestamp>[] = [];
    const bucketTimes: number[] = [];
    let lastTime = -Infinity;
    for (const c of aggregated) {
      const time = toChartTime(c.t);
      // Guard against DST folds producing non-increasing times (the library throws on those).
      if (time <= lastTime) continue;
      lastTime = time;
      candleData.push({ time, open: c.o * scale, high: c.h * scale, low: c.l * scale, close: c.c * scale });
      volumeData.push({ time, value: c.v, color: c.c >= c.o ? UP_VOL : DOWN_VOL });
      bucketTimes.push(c.t);
    }
    return { candleData, volumeData, bucketTimes };
  }, [aggregated, scale]);

  // ---- Markers --------------------------------------------------------------
  const markers = useMemo<MarkerMeta[]>(() => {
    const byId = new Map<number, LiveTrade>();
    for (const tr of trades) byId.set(tr.id, tr);
    const list = Array.from(byId.values())
      .filter((tr) => Number.isFinite(tr.priceSol) && tr.priceSol > 0)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id)
      .slice(-MAX_MARKERS);
    return list.map((tr) => {
      const bucketMs = bucketStart(new Date(tr.createdAt).getTime(), intervalMs);
      return { trade: tr, time: toChartTime(bucketMs), bucketMs, value: tr.priceSol * scale, size: markerSize(tr.sol) };
    });
  }, [trades, intervalMs, scale]);

  // Ids present on first render never "pop"; everything arriving later does.
  const initialIdsRef = useRef<Set<number> | null>(null);
  if (initialIdsRef.current === null) initialIdsRef.current = new Set(trades.map((tr) => tr.id));

  // ---- Refs shared with the imperative chart code -------------------------
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerElsRef = useRef(new Map<number, HTMLDivElement>());
  const markersRef = useRef<MarkerMeta[]>(markers);
  const bucketTimesRef = useRef<number[]>(bucketTimes);
  const placedRef = useRef(new Map<number, Placed>());
  const lastDataRef = useRef<{ key: string; data: CandlestickData<UTCTimestamp>[] } | null>(null);
  const rafRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const unitRef = useRef(unit);
  unitRef.current = unit;
  markersRef.current = markers;
  bucketTimesRef.current = bucketTimes;

  const [hover, setHover] = useState<{ id: number } | null>(null);

  const reposition = () => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;
    const ts = chart.timeScale();
    const pane = chart.paneSize();
    const cells = new Map<string, { x: number; y: number; n: number }>();
    const placed = placedRef.current;
    placed.clear();

    for (const m of markersRef.current) {
      const el = markerElsRef.current.get(m.trade.id);
      if (!el) continue;
      let x: number | null = ts.timeToCoordinate(m.time);
      if (x === null) {
        const idx = nearestIndex(bucketTimesRef.current, m.bucketMs);
        x = idx >= 0 ? ts.logicalToCoordinate(idx as Logical) : null;
      }
      const y = series.priceToCoordinate(m.value);
      if (x === null || y === null || x < -m.size || x > pane.width + m.size || y < -m.size || y > pane.height + m.size) {
        el.style.display = "none";
        continue;
      }
      const key = `${Math.floor(x / CLUSTER_CELL)}:${Math.floor(y / CLUSTER_CELL)}`;
      const cell = cells.get(key);
      let cx: number = x;
      let cy: number = y;
      let depth = 0;
      if (cell) {
        cx = cell.x;
        cy = cell.y + cell.n * STACK_OFFSET;
        depth = cell.n;
        cell.n++;
      } else {
        cells.set(key, { x, y, n: 1 });
      }
      el.style.display = "";
      el.style.transform = `translate(${Math.round(cx - m.size / 2)}px, ${Math.round(cy - m.size / 2)}px)`;
      el.style.zIndex = String(10 + depth);
      placed.set(m.trade.id, { x: cx, y: cy, size: m.size });
    }
  };
  const repositionRef = useRef(reposition);
  repositionRef.current = reposition;

  const schedule = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      repositionRef.current();
    });
  };
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const hasData = candleData.length > 0;

  // ---- Chart lifecycle ------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasData) return;

    // Some environments report tags Intl rejects (e.g. "en-US@posix"): fall back to en-US.
    let locale = "en-US";
    try {
      const candidate = typeof navigator !== "undefined" ? navigator.language : "en-US";
      locale = Intl.NumberFormat.supportedLocalesOf([candidate])[0] ?? "en-US";
    } catch {
      locale = "en-US";
    }
    const chart = createChart(el, {
      width: el.clientWidth || 300,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: palette.text,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: palette.text, labelBackgroundColor: "#242a35" },
        horzLine: { color: palette.text, labelBackgroundColor: "#242a35" },
      },
      rightPriceScale: {
        borderVisible: false,
        entireTextOnly: true,
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time: UTCTimestamp | { year: number; month: number; day: number } | string, type: TickMarkType) => {
          const d = typeof time === "number" ? new Date(time * 1000) : null;
          if (!d) return "";
          // The chart times are already shifted to local wall-clock, so format them as UTC.
          switch (type) {
            case TickMarkType.Year:
              return String(d.getUTCFullYear());
            case TickMarkType.Month:
              return d.toLocaleDateString(locale, { month: "short", timeZone: "UTC" });
            case TickMarkType.DayOfMonth:
              return d.toLocaleDateString(locale, { day: "numeric", timeZone: "UTC" });
            case TickMarkType.TimeWithSeconds:
              return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
            default:
              return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
          }
        },
      },
      localization: {
        locale,
        timeFormatter: (time: UTCTimestamp | { year: number; month: number; day: number } | string) => {
          if (typeof time !== "number") return "";
          return fromChartTime(time).toLocaleString(locale, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: palette.text,
      priceLineWidth: 1,
      priceFormat: {
        type: "custom",
        formatter: (p: number) =>
          modeRef.current === "mcap" ? fmtCompactAmount(p, unitRef.current) : fmtAxisPrice(p, unitRef.current),
        minMove: modeRef.current === "mcap" ? 1 : 1e-9,
      },
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    lastDataRef.current = null;

    const onRange = () => scheduleRef.current();
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.subscribeCrosshairMove(onRange);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) chart.applyOptions({ width: w, height });
      scheduleRef.current();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onRange);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      lastDataRef.current = null;
      placedRef.current.clear();
    };
  }, [hasData, height, palette]);

  // ---- Push data (incremental when only the tail changed) -----------------
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !series || !volume || candleData.length === 0) return;

    series.applyOptions({
      priceFormat: {
        type: "custom",
        formatter: (p: number) => (mode === "mcap" ? fmtCompactAmount(p, unit) : fmtAxisPrice(p, unit)),
        minMove: mode === "mcap" ? 1 : 1e-9,
      },
    });

    const key = `${mode}|${interval}`;
    const prev = lastDataRef.current;
    const sameBar = (a: CandlestickData<UTCTimestamp>, b: CandlestickData<UTCTimestamp>) =>
      a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
    const canAppend =
      prev !== null &&
      prev.key === key &&
      prev.data.length > 0 &&
      candleData.length >= prev.data.length &&
      candleData[0].time === prev.data[0].time &&
      (prev.data.length < 2 || sameBar(candleData[prev.data.length - 2], prev.data[prev.data.length - 2]));

    if (canAppend && prev) {
      for (let i = prev.data.length - 1; i < candleData.length; i++) {
        series.update(candleData[i]);
        volume.update(volumeData[i]);
      }
    } else {
      series.setData(candleData);
      volume.setData(volumeData);
      // Open on the most recent window rather than the whole history: fitting hundreds of
      // bars into a phone width makes every candle a hairline (see VISIBLE_BARS).
      const last = candleData.length - 1;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, last - VISIBLE_BARS) as Logical,
        to: (last + 3) as Logical,
      });
    }
    lastDataRef.current = { key, data: candleData };
    scheduleRef.current();
  }, [candleData, volumeData, mode, unit, interval, palette, height]);

  // ---- New trades: pop marker + follow real time ---------------------------
  const lastTradeId = markers.length ? markers[markers.length - 1].trade.id : 0;
  const seenLastRef = useRef(lastTradeId);
  useEffect(() => {
    if (lastTradeId !== seenLastRef.current) {
      seenLastRef.current = lastTradeId;
      chartRef.current?.timeScale().scrollToRealTime();
    }
    scheduleRef.current();
  }, [lastTradeId, markers]);

  // ---- Hover tooltip --------------------------------------------------------
  const hovered = hover ? markers.find((m) => m.trade.id === hover.id) : undefined;
  const hoveredPos = hovered ? placedRef.current.get(hovered.trade.id) : undefined;
  const tooltipText = (m: MarkerMeta) => {
    const who =
      user && user.walletAddress && user.walletAddress === m.trade.wallet
        ? t("chart.you")
        : m.trade.user
          ? `@${m.trade.user.username}`
          : shortCa(m.trade.wallet, 4, 4);
    const vars = {
      user: who,
      amount: `${fmtCompactAmount(m.trade.sol)} (${fmtTokens(m.trade.tokens)} ${ticker})`,
      price:
        mode === "mcap"
          ? fmtCompactAmount(m.trade.marketCapSol * conversion, unit)
          : fmtAxisPrice(m.trade.priceSol * conversion, unit),
    };
    return m.trade.side === "buy" ? t("chart.boughtAt", vars) : t("chart.soldAt", vars);
  };

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Controls */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          {(["price", "mcap"] as ChartMode[]).map((m) => (
            <ToggleButton key={m} active={mode === m} onClick={() => setMode(m)}>
              {m === "price" ? t("chart.price") : t("chart.mcap")}
            </ToggleButton>
          ))}
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
          {INTERVALS.map((i) => (
            <ToggleButton key={i} active={interval === i} onClick={() => setInterval_(i)}>
              {t(`chart.${i}`)}
            </ToggleButton>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative w-full overflow-hidden rounded-xl" style={{ height }}>
        {!hasData ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground">
            <BarChart3 className="h-6 w-6 opacity-60" />
            <span>{t("chart.noTrades")}</span>
          </div>
        ) : (
          <>
            <div ref={containerRef} className="absolute inset-0" />
            {/* Avatar marker overlay */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
              {markers.map((m) => {
                const pop = !initialIdsRef.current!.has(m.trade.id);
                const buy = m.trade.side === "buy";
                return (
                  <div
                    key={m.trade.id}
                    ref={(el) => {
                      if (el) markerElsRef.current.set(m.trade.id, el);
                      else markerElsRef.current.delete(m.trade.id);
                    }}
                    className="pointer-events-auto absolute left-0 top-0 will-change-transform"
                    style={{ display: "none", width: m.size, height: m.size }}
                    onMouseEnter={() => setHover({ id: m.trade.id })}
                    onMouseLeave={() => setHover((h) => (h?.id === m.trade.id ? null : h))}
                  >
                    <motion.div
                      initial={pop ? { scale: 0, opacity: 0 } : false}
                      animate={
                        pop
                          ? {
                              scale: [0, 1.35, 1],
                              opacity: 1,
                              boxShadow: [
                                `0 0 0 0 ${buy ? "rgba(34,197,94,0.9)" : "rgba(244,63,94,0.9)"}`,
                                `0 0 0 10px ${buy ? "rgba(34,197,94,0)" : "rgba(244,63,94,0)"}`,
                                `0 0 0 0 ${buy ? "rgba(34,197,94,0)" : "rgba(244,63,94,0)"}`,
                              ],
                            }
                          : { scale: 1, opacity: 1 }
                      }
                      transition={{ duration: 0.6, ease: "easeOut" }}
                      whileHover={{ scale: 1.15 }}
                      className={cn(
                        "rounded-full ring-2 shadow-md cursor-pointer bg-card",
                        buy ? "ring-[#22c55e]" : "ring-[#f43f5e]",
                      )}
                      style={{ width: m.size, height: m.size }}
                    >
                      <MarkerAvatar user={m.trade.user} wallet={m.trade.wallet} size={m.size} />
                    </motion.div>
                  </div>
                );
              })}
            </div>
            {/* Tooltip */}
            {hovered && hoveredPos && (
              <div
                className="pointer-events-none absolute z-50 max-w-[240px] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
                style={{
                  left: Math.max(90, Math.min(hoveredPos.x, (containerRef.current?.clientWidth ?? 300) - 90)),
                  top: Math.max(4, hoveredPos.y - hoveredPos.size / 2 - 40),
                }}
              >
                <div className="font-medium leading-snug">{tooltipText(hovered)}</div>
                <div className="mt-0.5 text-muted-foreground">
                  {new Date(hovered.trade.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function MarkerAvatar({ user, wallet, size }: { user: PublicUser | null; wallet: string; size: number }) {
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className="block rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return <UserAvatar seed={user?.avatarSeed ?? wallet} name={user?.username ?? wallet} size={size} />;
}

export default CandleChart;
