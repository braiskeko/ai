import { Link } from "wouter";
import { Clock, TrendingDown, TrendingUp, Users } from "lucide-react";
import type { MarketSummary } from "@shared/schema";
import { cents, usd, endsIn } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MarketCard({ market }: { market: MarketSummary }) {
  const yes = Math.round(market.yesPrice * 100);
  const change = Math.round(market.change24h * 100);
  const resolved = market.status === "resolved";
  const closed = market.status === "closed";

  return (
    <Link
      href={`/market/${market.slug}`}
      className="group flex flex-col rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border hover:bg-accent/40"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-xl">
          {market.imageEmoji}
        </div>
        <h3 className="line-clamp-3 flex-1 text-[15px] font-semibold leading-snug">{market.question}</h3>
        <div className="shrink-0 text-right">
          {resolved ? (
            <span
              className={cn(
                "rounded-md px-2 py-1 text-xs font-bold",
                market.resolution === "YES" ? "bg-yes/15 text-yes" : "bg-no/15 text-no",
              )}
            >
              {market.resolution}
            </span>
          ) : (
            <ProbabilityRing value={yes} />
          )}
        </div>
      </div>

      {!resolved && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <span
            className={cn(
              "rounded-md bg-yes/15 py-2 text-center text-sm font-semibold text-yes transition-colors",
              !closed && "group-hover:bg-yes/25",
            )}
          >
            Yes {cents(market.yesPrice)}
          </span>
          <span
            className={cn(
              "rounded-md bg-no/15 py-2 text-center text-sm font-semibold text-no transition-colors",
              !closed && "group-hover:bg-no/25",
            )}
          >
            No {cents(market.noPrice)}
          </span>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular">{usd(market.volume, { compact: true, digits: 0 })} Vol.</span>
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {market.traders}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {resolved ? (
            "Resolved"
          ) : (
            <>
              <Clock className="h-3 w-3" />
              {endsIn(market.endDate).replace(" from now", "")}
            </>
          )}
        </span>
        {!resolved && change !== 0 && (
          <span className={cn("flex items-center gap-0.5 font-medium", change > 0 ? "text-yes" : "text-no")}>
            {change > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(change)}
          </span>
        )}
      </div>
    </Link>
  );
}

export function ProbabilityRing({ value, size = 44 }: { value: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  const color = value >= 50 ? "hsl(var(--yes))" : "hsl(var(--no))";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <div>
          <div className="text-sm font-bold tabular">{value}%</div>
          <div className="text-[9px] uppercase text-muted-foreground">chance</div>
        </div>
      </div>
    </div>
  );
}
