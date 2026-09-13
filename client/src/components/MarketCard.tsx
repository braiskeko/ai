import type { MouseEvent } from "react";
import { Link } from "wouter";
import { CheckCircle2, ChevronDown, ChevronUp, Clock, MessageSquare, Users } from "lucide-react";
import type { MarketSummary } from "@shared/schema";
import { cents, endsIn, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProbabilityGauge } from "@/components/ProbabilityGauge";

const MAX_MULTI_ROWS = 3;

const stop = (e: MouseEvent) => e.stopPropagation();

function TradeButton({
  href,
  side,
  label,
  className,
}: {
  href: string;
  side: "yes" | "no";
  label: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={stop}
      className={cn(
        "flex h-9 items-center justify-center rounded-lg text-sm font-semibold transition-colors tabular",
        side === "yes" ? "bg-yes/10 text-yes hover:bg-yes hover:text-white" : "bg-no/10 text-no hover:bg-no hover:text-white",
        className,
      )}
    >
      {label}
    </Link>
  );
}

export function MarketCard({ market }: { market: MarketSummary }) {
  const href = `/market/${market.slug}`;
  const open = market.status === "open";
  const resolved = market.status === "resolved";
  const closed = market.status === "closed";
  const yesPrice = market.prices[0] ?? 0;
  const noPrice = market.prices[1] ?? 1 - yesPrice;
  const winner = resolved && market.resolution !== null ? market.outcomes[market.resolution] : undefined;

  const ranked = market.outcomes
    .map((o) => ({ outcome: o, price: market.prices[o.id] ?? 0 }))
    .sort((a, b) => b.price - a.price);
  const shown = ranked.slice(0, MAX_MULTI_ROWS);
  const more = ranked.length - shown.length;

  const change = market.change24h;
  const showChange = Math.abs(change) >= 0.01 && !resolved;
  const changePts = Math.round(Math.abs(change) * 100);

  return (
    <Link
      href={href}
      className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 text-card-foreground transition-all hover:border-border hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-xl leading-none">
          {market.imageEmoji}
        </div>
        <h3 className="line-clamp-2 flex-1 text-[15px] font-semibold leading-snug">{market.question}</h3>
        {market.binary && !resolved && <ProbabilityGauge value={yesPrice} size={56} className="-mt-1" />}
      </div>

      {/* Body */}
      <div className="mt-4 flex-1">
        {resolved ? (
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold",
              market.binary
                ? market.resolution === 0
                  ? "bg-yes/10 text-yes"
                  : "bg-no/10 text-no"
                : "bg-muted text-foreground",
            )}
            style={!market.binary && winner ? { backgroundColor: `${winner.color}1f`, color: winner.color } : undefined}
          >
            <CheckCircle2 className="h-4 w-4" />
            Resolved: {winner?.name ?? "—"}
          </div>
        ) : closed ? (
          <div className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-4 w-4" />
            Awaiting resolution
          </div>
        ) : market.binary ? (
          <div className="grid grid-cols-2 gap-2">
            <TradeButton href={`${href}?outcome=0`} side="yes" label={`Buy Yes ${cents(yesPrice)}`} />
            <TradeButton href={`${href}?outcome=1`} side="no" label={`Buy No ${cents(noPrice)}`} />
          </div>
        ) : (
          <ul className="space-y-1.5">
            {shown.map(({ outcome, price }) => (
              <li key={outcome.id} className="flex items-center gap-2 text-sm">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: outcome.color }} />
                <span className="min-w-0 flex-1 truncate">{outcome.name}</span>
                <span className="shrink-0 font-bold tabular">{pct(price)}</span>
                {open && (
                  <span className="hidden shrink-0 items-center gap-1 sm:flex">
                    <TradeButton href={`${href}?outcome=${outcome.id}`} side="yes" label="Yes" className="h-6 px-2 text-xs" />
                    <TradeButton href={`${href}?outcome=${outcome.id}`} side="no" label="No" className="h-6 px-2 text-xs" />
                  </span>
                )}
              </li>
            ))}
            {more > 0 && <li className="text-xs text-muted-foreground">+{more} more</li>}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular">{usd(market.volume, { compact: true, digits: 0 })} Vol.</span>
        <span className="flex items-center gap-1 tabular" title="Traders">
          <Users className="h-3.5 w-3.5" />
          {market.traders}
        </span>
        <span className="flex items-center gap-1 tabular" title="Comments">
          <MessageSquare className="h-3.5 w-3.5" />
          {market.commentCount}
        </span>
        <span className="ml-auto truncate">{resolved ? "Resolved" : endsIn(market.endDate).replace(" from now", "")}</span>
        {showChange && (
          <span
            className={cn("flex shrink-0 items-center gap-0.5 font-semibold tabular", change > 0 ? "text-yes" : "text-no")}
            title="24h change"
          >
            {change > 0 ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {changePts}
          </span>
        )}
      </div>
    </Link>
  );
}
