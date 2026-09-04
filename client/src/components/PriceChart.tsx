import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

type Range = "1D" | "1W" | "1M" | "ALL";
const RANGES: Range[] = ["1D", "1W", "1M", "ALL"];
const RANGE_MS: Record<Range, number> = {
  "1D": 86400_000,
  "1W": 7 * 86400_000,
  "1M": 30 * 86400_000,
  ALL: Infinity,
};

export function PriceChart({
  history,
  className,
  height = 260,
}: {
  history: { t: string; p: number }[];
  className?: string;
  height?: number;
}) {
  const [range, setRange] = useState<Range>("ALL");

  const data = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    const points = history.map((h) => ({ t: new Date(h.t).getTime(), p: Math.round(h.p * 1000) / 10 }));
    const filtered = points.filter((pt) => pt.t >= cutoff);
    // Always include the last point before the cutoff so the line starts at the edge.
    const before = points.filter((pt) => pt.t < cutoff);
    const start = before.length ? [{ ...before[before.length - 1], t: cutoff }] : [];
    const merged = [...start, ...filtered];
    // extend to "now" so the chart reaches the right edge
    if (merged.length) merged.push({ ...merged[merged.length - 1], t: Date.now() });
    return merged.length >= 2 ? merged : points.length ? [...points, { ...points[points.length - 1], t: Date.now() }] : [];
  }, [history, range]);

  const last = data[data.length - 1]?.p ?? 50;
  const first = data[0]?.p ?? last;
  const up = last >= first;
  const color = up ? "hsl(var(--yes))" : "hsl(var(--no))";

  return (
    <div className={cn("flex flex-col", className)}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => format(v, range === "1D" ? "HH:mm" : "MMM d")}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              width={40}
              orientation="right"
            />
            <ReferenceLine y={50} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => format(Number(v), "MMM d, yyyy HH:mm")}
              formatter={(v) => [`${Number(v).toFixed(1)}%`, "Yes"]}
            />
            <Area
              type="monotone"
              dataKey="p"
              stroke={color}
              strokeWidth={2}
              fill="url(#chartFill)"
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              range === r ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
