import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { MarketDetail, MarketOutcome, Position, SafeUser, Trade, TradeQuote } from "@shared/schema";
import { YES_COLOR, NO_COLOR } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { cents, usd, shares as fmtShares } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";

type Side = "buy" | "sell";

const EPS = 1e-6;
const BUY_PRESETS = [1, 20, 100] as const;
const SELL_PRESETS = [0.25, 0.5, 0.75] as const;

function outcomeColor(market: MarketDetail, outcome: MarketOutcome): string {
  if (market.binary) return outcome.id === 0 ? YES_COLOR : NO_COLOR;
  return outcome.color;
}

/** Sanitises free text into a decimal string with at most one dot. */
function sanitizeDecimal(v: string): string {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

function trimNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, "");
}

export function TradePanel({
  market,
  selectedOutcome,
  onSelectOutcome,
}: {
  market: MarketDetail;
  selectedOutcome: number;
  onSelectOutcome: (id: number) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, isLoading: authLoading, openLogin } = useAuth();

  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const amount = Number(raw) || 0;

  const outcome: MarketOutcome =
    market.outcomes.find((o) => o.id === selectedOutcome) ?? market.outcomes[0] ?? { id: 0, name: "Yes", color: YES_COLOR };
  const price = market.prices[outcome.id] ?? 0;
  const color = outcomeColor(market, outcome);
  const tradable = market.status === "open";

  const positions = useMemo(
    () => market.myPositions.filter((p) => p.shares > EPS).sort((a, b) => b.shares - a.shares),
    [market.myPositions],
  );
  const position: Position | undefined = positions.find((p) => p.outcomeId === outcome.id);
  const owned = position?.shares ?? 0;
  const balance = user?.balance ?? 0;

  // ---- Debounced quote ------------------------------------------------------
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const pricesKey = market.prices.join(",");

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!tradable || amount <= 0) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/markets/${market.id}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcomeId: outcome.id, side, amount }),
          credentials: "include",
          signal: ctl.signal,
        });
        if (!res.ok) {
          const text = (await res.text()) || res.statusText;
          throw new Error(`${res.status}: ${text}`);
        }
        const body = (await res.json()) as TradeQuote;
        if (!ctl.signal.aborted) {
          setQuote(body);
          setQuoting(false);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setQuoteError(apiErrorMessage(e, "Could not fetch a quote"));
        setQuoting(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [amount, outcome.id, side, market.id, pricesKey, tradable]);

  // ---- Trade mutation -------------------------------------------------------
  const trade = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/markets/${market.id}/trade`, {
        outcomeId: outcome.id,
        side,
        amount,
      });
      return (await res.json()) as { trade: Trade; market: MarketDetail; user: SafeUser };
    },
    onSuccess: (data) => {
      qc.setQueryData(["/api/me"], data.user);
      qc.invalidateQueries({ queryKey: [`/api/markets/${market.slug}`] });
      qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      setRaw("");
      toast({
        title: "Order filled",
        description:
          side === "buy"
            ? `Bought ${fmtShares(data.trade.shares)} ${outcome.name} shares for ${usd(data.trade.amount)}`
            : `Sold ${fmtShares(data.trade.shares)} ${outcome.name} shares for ${usd(data.trade.amount)}`,
      });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Trade failed", description: apiErrorMessage(err) });
    },
  });

  // ---- Derived UI state -----------------------------------------------------
  const exceedsBalance = side === "buy" && !!user && amount > balance + 1e-9;
  const exceedsOwned = side === "sell" && amount > owned + EPS;
  const invalid = amount <= 0 || exceedsBalance || exceedsOwned;

  const potentialReturn = quote && side === "buy" ? quote.maxPayout : null;
  const returnPct = potentialReturn !== null && amount > 0 ? ((potentialReturn - amount) / amount) * 100 : null;

  const selectOutcome = (id: number) => {
    if (id !== outcome.id) {
      onSelectOutcome(id);
      if (side === "sell") setRaw("");
    }
  };

  const switchSide = (s: Side) => {
    if (s !== side) {
      setSide(s);
      setRaw("");
    }
  };

  const ctaLabel = (): ReactNode => {
    if (trade.isPending) return <Loader2 className="h-5 w-5 animate-spin" />;
    if (!tradable) return market.status === "resolved" ? "Resolved" : "Trading closed";
    if (!user) return "Log in to trade";
    if (exceedsBalance) return "Insufficient balance";
    if (exceedsOwned) return "Not enough shares";
    const verb = side === "buy" ? "Buy" : "Sell";
    return `${verb} ${outcome.name}`;
  };

  const ctaDisabled =
    trade.isPending || !tradable || (!!user && (invalid || quoting || !quote || !!quoteError));

  const onCta = () => {
    if (!tradable) return;
    if (!user) {
      openLogin();
      return;
    }
    if (ctaDisabled) return;
    trade.mutate();
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Buy / Sell tabs */}
      <div className="flex items-center border-b border-border px-4">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => switchSide(s)}
            aria-pressed={side === s}
            className={cn(
              "relative -mb-px px-3 py-3 text-sm font-semibold capitalize transition-colors",
              side === s ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
            {side === s && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />}
          </button>
        ))}
        {market.binary && (
          <span className="ml-auto text-xs text-muted-foreground tabular">
            {pct100(market.prices[0] ?? 0)}% chance
          </span>
        )}
      </div>

      {/* My positions */}
      {user && positions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Your position
          </span>
          {positions.map((p) => {
            const o = market.outcomes.find((x) => x.id === p.outcomeId);
            if (!o) return null;
            const c = outcomeColor(market, o);
            const active = o.id === outcome.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectOutcome(o.id)}
                title={`Cost basis ${usd(p.costBasis)}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular transition-colors",
                  active ? "border-transparent text-white" : "border-transparent hover:opacity-80",
                )}
                style={active ? { background: c } : { background: `${c}1f`, color: c }}
              >
                {fmtShares(p.shares)} {o.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-4 p-4">
        {/* Outcome selector */}
        {market.binary ? (
          <div className="grid grid-cols-2 gap-2">
            {market.outcomes.slice(0, 2).map((o) => {
              const active = o.id === outcome.id;
              const yes = o.id === 0;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => selectOutcome(o.id)}
                  aria-pressed={active}
                  className={cn(
                    "flex h-12 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors",
                    active
                      ? yes
                        ? "bg-yes text-white"
                        : "bg-no text-white"
                      : "bg-muted text-foreground hover:bg-accent",
                  )}
                >
                  {o.name} <span className="tabular">{cents(market.prices[o.id] ?? 0)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-0.5">
            {market.outcomes.map((o) => {
              const active = o.id === outcome.id;
              const p = market.prices[o.id] ?? 0;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => selectOutcome(o.id)}
                  aria-pressed={active}
                  className={cn(
                    "flex h-11 items-center gap-3 rounded-lg border px-3 text-sm transition-colors",
                    active ? "font-semibold" : "border-border bg-background hover:bg-accent",
                  )}
                  style={active ? { background: `${o.color}1a`, borderColor: o.color } : undefined}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.color }} />
                  <span className="min-w-0 flex-1 truncate text-left">{o.name}</span>
                  <span className="tabular text-muted-foreground">{pct100(p)}%</span>
                  <span className="tabular font-semibold" style={active ? { color: o.color } : undefined}>
                    {cents(p)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Amount */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">{side === "buy" ? "Amount" : "Shares"}</span>
            {authLoading ? (
              <Skeleton className="h-3.5 w-20" />
            ) : user ? (
              <span className="tabular">
                {side === "buy" ? `Balance ${usd(balance)}` : `You own ${fmtShares(owned)}`}
              </span>
            ) : null}
          </div>
          <div className="relative">
            {side === "buy" && (
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-2xl font-medium text-muted-foreground">
                $
              </span>
            )}
            <input
              inputMode="decimal"
              autoComplete="off"
              value={raw}
              disabled={!tradable}
              onChange={(e) => setRaw(sanitizeDecimal(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCta();
              }}
              placeholder="0"
              aria-label={side === "buy" ? "Amount in dollars" : "Number of shares"}
              className={cn(
                "h-14 w-full rounded-lg border border-input bg-background text-3xl font-semibold tabular outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                side === "buy" ? "pl-9 pr-3" : "px-3",
              )}
            />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {side === "buy"
              ? BUY_PRESETS.map((inc) => (
                  <QuickButton
                    key={inc}
                    disabled={!tradable}
                    onClick={() => setRaw(trimNumber(amount + inc))}
                  >
                    +${inc}
                  </QuickButton>
                ))
              : SELL_PRESETS.map((f) => (
                  <QuickButton
                    key={f}
                    disabled={!tradable || owned <= 0}
                    onClick={() => setRaw(trimNumber(owned * f, 4))}
                  >
                    {Math.round(f * 100)}%
                  </QuickButton>
                ))}
            <QuickButton
              disabled={!tradable || (side === "buy" ? !user || balance <= 0 : owned <= 0)}
              onClick={() => setRaw(side === "buy" ? trimNumber(Math.floor(balance * 100) / 100) : trimNumber(owned, 6))}
            >
              Max
            </QuickButton>
          </div>
        </div>

        {/* Quote */}
        <div className="space-y-1.5 rounded-lg bg-muted/50 p-3 text-sm">
          <Row label="Avg price" value={quote ? cents(quote.avgPrice) : cents(price)} loading={quoting} />
          {side === "buy" ? (
            <>
              <Row label="Shares" value={quote ? fmtShares(quote.shares) : "—"} loading={quoting} />
              <Row
                label="Potential return"
                loading={quoting}
                value={
                  potentialReturn !== null && returnPct !== null ? (
                    <span className="text-yes">
                      {usd(potentialReturn)} <span className="text-xs">({returnPct.toFixed(0)}%)</span>
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </>
          ) : (
            <Row label="You receive" value={quote ? usd(quote.amount) : "—"} loading={quoting} />
          )}
          <Row
            label="Price impact"
            loading={quoting}
            value={
              quote ? (
                <span className="tabular">
                  {cents(quote.priceBefore)} <span className="text-muted-foreground">→</span> {cents(quote.priceAfter)}
                </span>
              ) : (
                "—"
              )
            }
          />
          {quoteError && <div className="pt-1 text-xs text-no">{quoteError}</div>}
        </div>

        {/* CTA */}
        <Button
          type="button"
          onClick={onCta}
          disabled={ctaDisabled}
          className={cn(
            "h-12 w-full rounded-lg text-base font-semibold text-white shadow-none hover:opacity-90",
            market.binary ? (outcome.id === 0 ? "bg-yes hover:bg-yes" : "bg-no hover:bg-no") : "",
            !tradable && "bg-muted text-muted-foreground hover:bg-muted",
            !user && tradable && "bg-primary hover:bg-primary",
          )}
          style={tradable && user && !market.binary ? { background: color } : undefined}
        >
          {ctaLabel()}
        </Button>

        <p className="text-center text-[11px] leading-snug text-muted-foreground">
          Each share pays $1.00 if the outcome wins.
        </p>
      </div>
    </div>
  );
}

function pct100(p: number) {
  return Math.round(p * 100);
}

function Row({ label, value, loading }: { label: string; value: ReactNode; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {loading ? <Skeleton className="h-4 w-16" /> : <span className="font-medium tabular">{value}</span>}
    </div>
  );
}

function QuickButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-md border border-border bg-background text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
