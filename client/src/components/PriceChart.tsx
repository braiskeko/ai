import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { format } from "date-fns";
import type { MarketOutcome, PricePoint } from "@shared/schema";
import { YES_COLOR } from "@shared/schema";
import { cn } from "@/lib/utils";

type Range = "1H" | "6H" | "1D" | "1W" | "1M" | "ALL";
const RANGES: Range[] = ["1H", "6H", "1D", "1W", "1M", "ALL"];
const RANGE_MS: Record<Range, number> = {
  "1H": 3600_000,
  "6H": 6 * 3600_000,
  "1D": 86400_000,
  "1W": 7 * 86400_000,
  "1M": 30 * 86400_000,
  ALL: Infinity,
};

const MAX_SERIES = 5;

interface Series {
  key: string;
  outcome: MarketOutcome;
  /** current probability 0..1 */
  current: number;
}

type Row = { t: number } & Record<string, number>;

const seriesKey = (id: number) => `o${id}`;

function tickFormat(range: Range, spanMs: number) {
  if (range === "1H" || range === "6H") return "HH:mm";
  if (range === "1D") return "HH:mm";
  if (range === "1W") return "EEE d";
  if (range === "1M") return "MMM d";
  // ALL: pick by actual span
  if (spanMs <= 86400_000) return "HH:mm";
  if (spanMs <= 90 * 86400_000) return "MMM d";
  return "MMM yyyy";
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: TooltipProps<number, string> & { series: Series[] }) {
  if (!active || !payload || payload.length === 0 || typeof label !== "number") return null;
  const byKey = new Map<string, number>();
  for (const p of payload) {
    if (typeof p.dataKey === "string" && typeof p.value === "number") byKey.set(p.dataKey, p.value);
  }
  return (
    <div className="min-w-[160px] rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1.5 text-muted-foreground">{format(label, "MMM d, yyyy · HH:mm")}</div>
      <div className="space-y-1">
        {series.map((s) => {
          const v = byKey.get(s.key);
          if (v === undefined) return null;
          return (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.outcome.color }} />
                <span className="truncate font-medium text-foreground">{s.outcome.name}</span>
              </span>
              <span className="tabular font-semibold text-foreground">{v.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PriceChart({
  history,
  outcomes,
  binary,
  height = 280,
  selectedOutcome,
  resolved = false,
  className,
}: {
  history: PricePoint[];
  outcomes: MarketOutcome[];
  binary: boolean;
  height?: number;
  selectedOutcome?: number;
  resolved?: boolean;
  className?: string;
}) {
  const [range, setRange] = useState<Range>("ALL");

  // Sorted, de-duplicated timeline in ms.
  const points = useMemo(() => {
    const out: { t: number; p: number[] }[] = [];
    for (const h of history) {
      const t = new Date(h.t).getTime();
      if (Number.isNaN(t)) continue;
      out.push({ t, p: h.p });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [history]);

  const current = useMemo(() => {
    const last = points[points.length - 1];
    return outcomes.map((o) => last?.p[o.id] ?? 1 / Math.max(outcomes.length, 1));
  }, [points, outcomes]);

  const series = useMemo<Series[]>(() => {
    if (binary) {
      const yes = outcomes[0];
      if (!yes) return [];
      return [{ key: seriesKey(yes.id), outcome: { ...yes, color: YES_COLOR }, current: current[0] ?? 0.5 }];
    }
    const ranked = outcomes
      .map((o, i) => ({ outcome: o, current: current[i] ?? 0 }))
      .sort((a, b) => b.current - a.current);
    let top = ranked.slice(0, MAX_SERIES);
    if (selectedOutcome !== undefined && !top.some((s) => s.outcome.id === selectedOutcome)) {
      const sel = ranked.find((s) => s.outcome.id === selectedOutcome);
      if (sel) top = [...top.slice(0, MAX_SERIES - 1), sel];
    }
    // Keep outcome order stable (by id) so legend/colors don't jump around.
    top.sort((a, b) => a.outcome.id - b.outcome.id);
    return top.map((s) => ({ key: seriesKey(s.outcome.id), outcome: s.outcome, current: s.current }));
  }, [binary, outcomes, current, selectedOutcome]);

  const data = useMemo<Row[]>(() => {
    if (points.length === 0) return [];
    const now = Date.now();
    const cutoff = range === "ALL" ? -Infinity : now - RANGE_MS[range];
    const toRow = (t: number, p: number[]): Row => {
      const row: Row = { t } as Row;
      for (const s of series) row[s.key] = Math.round((p[s.outcome.id] ?? 0) * 1000) / 10;
      return row;
    };
    const rows: Row[] = [];
    let lastBefore: { t: number; p: number[] } | null = null;
    for (const pt of points) {
      if (pt.t < cutoff) lastBefore = pt;
      else rows.push(toRow(pt.t, pt.p));
    }
    // Include the last point before the cutoff, clamped to the cutoff, so the line starts at the left edge.
    if (lastBefore) rows.unshift(toRow(cutoff, lastBefore.p));
    if (rows.length === 0) return [];
    // Synthetic "now" point so the line reaches the right edge.
    const tail = points[points.length - 1];
    const end = resolved ? Math.max(tail.t, rows[rows.length - 1].t) : Math.max(now, tail.t);
    if (rows[rows.length - 1].t < end) rows.push(toRow(end, tail.p));
    else if (rows.length === 1) rows.push({ ...rows[0], t: rows[0].t + 1000 });
    return rows;
  }, [points, range, series, resolved]);

  const spanMs = data.length ? data[data.length - 1].t - data[0].t : 0;
  const fmt = tickFormat(range, spanMs);
  const last = data[data.length - 1];

  const axisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
  const gradientId = useMemo(() => `pc-fill-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Legend */}
      {series.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          {series.map((s) => {
            const isSel = selectedOutcome === s.outcome.id;
            return (
              <div
                key={s.key}
                className={cn(
                  "flex items-center gap-1.5 text-xs",
                  isSel || selectedOutcome === undefined ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.outcome.color }} />
                <span className={cn("font-medium", isSel && "font-semibold")}>{s.outcome.name}</span>
                <span className="tabular font-semibold" style={{ color: s.outcome.color }}>
                  {Math.round(s.current * 100)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ height }} className="relative w-full">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
            No price history yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={YES_COLOR} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={YES_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                horizontal
                vertical={false}
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
              />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => format(v, fmt)}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                minTickGap={56}
                tickMargin={8}
              />
              <YAxis
                orientation="right"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3", strokeWidth: 1 }}
                content={<ChartTooltip series={series} />}
                isAnimationActive={false}
              />
              {binary
                ? series.map((s) => (
                    <Area
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      stroke={s.outcome.color}
                      strokeWidth={2.25}
                      fill={`url(#${gradientId})`}
                      isAnimationActive={false}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: s.outcome.color }}
                      connectNulls
                    />
                  ))
                : series.map((s) => {
                    const isSel = selectedOutcome === s.outcome.id;
                    const dim = selectedOutcome !== undefined && !isSel;
                    return (
                      <Line
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        stroke={s.outcome.color}
                        strokeWidth={isSel ? 3 : 1.75}
                        strokeOpacity={dim ? 0.55 : 1}
                        isAnimationActive={false}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0, fill: s.outcome.color }}
                        connectNulls
                      />
                    );
                  })}
              {last &&
                series.map((s) => {
                  const emphasize = binary || selectedOutcome === undefined || selectedOutcome === s.outcome.id;
                  if (!emphasize) return null;
                  return (
                    <ReferenceDot
                      key={`end-${s.key}`}
                      x={last.t}
                      y={last[s.key]}
                      r={resolved ? 3.5 : 4}
                      fill={s.outcome.color}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                      isFront
                    />
                  );
                })}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Range selector */}
      <div className="mt-2 flex items-center gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            aria-pressed={range === r}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
              range === r ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}
        {resolved && <span className="ml-auto text-xs text-muted-foreground">Final</span>}
      </div>
    </div>
  );
}
