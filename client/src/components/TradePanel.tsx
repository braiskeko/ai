import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { MarketDetail, Outcome, TradeQuote, User, Position } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { cents, usd, shares as fmtShares, signedUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type Side = "buy" | "sell";

export function TradePanel({ market }: { market: MarketDetail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useQuery<Omit<User, "sessionId">>({ queryKey: ["/api/me"] });

  const [side, setSide] = useState<Side>("buy");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [raw, setRaw] = useState("");
  const amount = Number(raw) || 0;

  const position: Position | undefined = market.myPositions.find((p) => p.outcome === outcome && p.shares > 1e-6);
  const owned = position?.shares ?? 0;
  const tradable = market.status === "open";

  // Live quote (debounced) so the user sees shares/avg price before confirming.
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!tradable || amount <= 0) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/markets/${market.id}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome, side, amount }),
          signal: ctl.signal,
          credentials: "include",
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.message);
        setQuote(body);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setQuoteError((e as Error).message);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [amount, outcome, side, market.id, market.qYes, market.qNo, tradable]);

  const trade = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/markets/${market.id}/trade`, { outcome, side, amount });
      return res.json();
    },
    onSuccess: (data: { user: Omit<User, "sessionId"> }) => {
      qc.setQueryData(["/api/me"], data.user);
      qc.invalidateQueries({ queryKey: [`/api/markets/${market.slug}`] });
      qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      setRaw("");
      toast({
        title: side === "buy" ? "Order filled" : "Shares sold",
        description:
          side === "buy"
            ? `Bought ${fmtShares(quote?.shares ?? 0)} ${outcome} shares for ${usd(amount)}`
            : `Sold ${fmtShares(amount)} ${outcome} shares for ${usd(quote?.amount ?? 0)}`,
      });
    },
    onError: (e: Error) => {
      toast({ variant: "destructive", title: "Trade failed", description: e.message.replace(/^\d+: /, "") });
    },
  });

  const presets = useMemo(
    () => (side === "buy" ? [10, 50, 100, 500] : [0.25, 0.5, 0.75, 1]),
    [side],
  );

  const price = outcome === "YES" ? market.yesPrice : market.noPrice;
  const invalid =
    amount <= 0 ||
    (side === "buy" && me && amount > me.balance + 1e-9) ||
    (side === "sell" && amount > owned + 1e-6);

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      {/* Buy / Sell tabs */}
      <div className="flex border-b border-border/60 px-4">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            onClick={() => {
              setSide(s);
              setRaw("");
            }}
            className={cn(
              "relative px-3 py-3 text-sm font-semibold capitalize transition-colors",
              side === s ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
            {side === s && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
        {tradable && market.myPositions.some((p) => p.shares > 1e-6) && (
          <div className="ml-auto self-center text-xs text-muted-foreground">
            {market.myPositions
              .filter((p) => p.shares > 1e-6)
              .map((p) => (
                <span key={p.outcome} className="ml-2">
                  <span className={p.outcome === "YES" ? "text-yes" : "text-no"}>{p.outcome}</span>{" "}
                  <span className="tabular">{fmtShares(p.shares)}</span>
                </span>
              ))}
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        {/* Outcome */}
        <div className="grid grid-cols-2 gap-2">
          <OutcomeButton
            label="Yes"
            price={market.yesPrice}
            active={outcome === "YES"}
            tone="yes"
            onClick={() => {
              setOutcome("YES");
              setRaw("");
            }}
          />
          <OutcomeButton
            label="No"
            price={market.noPrice}
            active={outcome === "NO"}
            tone="no"
            onClick={() => {
              setOutcome("NO");
              setRaw("");
            }}
          />
        </div>

        {/* Amount */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{side === "buy" ? "Amount" : "Shares"}</span>
            <span className="tabular">
              {side === "buy" ? `Balance ${usd(me?.balance ?? 0)}` : `You own ${fmtShares(owned)}`}
            </span>
          </div>
          <div className="relative">
            {side === "buy" && (
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">
                $
              </span>
            )}
            <input
              inputMode="decimal"
              value={raw}
              disabled={!tradable}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                if ((v.match(/\./g) ?? []).length <= 1) setRaw(v);
              }}
              placeholder="0"
              className={cn(
                "h-14 w-full rounded-lg border border-input bg-background text-2xl font-semibold tabular outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                side === "buy" ? "pl-8 pr-3" : "px-3",
              )}
            />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {presets.map((p) => (
              <button
                key={p}
                disabled={!tradable}
                onClick={() => {
                  if (side === "buy") setRaw(String(Math.min(p, me?.balance ?? p)));
                  else setRaw(owned > 0 ? (owned * p).toFixed(2) : "0");
                }}
                className="rounded-md border border-border/60 bg-background py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {side === "buy" ? `+$${p}` : p === 1 ? "Max" : `${p * 100}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Quote */}
        <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
          <Row label="Avg price" value={cents(quote?.avgPrice ?? price)} />
          {side === "buy" ? (
            <>
              <Row label="Shares" value={fmtShares(quote?.shares ?? 0)} />
              <Row
                label="Potential return"
                value={
                  quote ? (
                    <span className="text-yes">
                      {usd(quote.maxPayout)}{" "}
                      <span className="text-xs">
                        ({amount > 0 ? `${(((quote.maxPayout - amount) / amount) * 100).toFixed(0)}%` : "0%"})
                      </span>
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </>
          ) : (
            <>
              <Row label="You receive" value={quote ? usd(quote.amount) : "—"} />
              {position && quote && (
                <Row
                  label="Realized P&L"
                  value={
                    <span className={quote.amount - position.costBasis * (amount / owned) >= 0 ? "text-yes" : "text-no"}>
                      {signedUsd(quote.amount - position.costBasis * (Math.min(amount, owned) / owned))}
                    </span>
                  }
                />
              )}
            </>
          )}
          <Row
            label="Price impact"
            value={
              quote ? (
                <span className="tabular">
                  {cents(quote.priceBefore)} → {cents(quote.priceAfter)}
                </span>
              ) : (
                "—"
              )
            }
          />
          {quoteError && <div className="pt-1 text-xs text-no">{quoteError}</div>}
        </div>

        <Button
          className={cn(
            "h-12 w-full text-base font-semibold",
            outcome === "YES" ? "bg-yes text-white hover:bg-yes/90" : "bg-no text-white hover:bg-no/90",
          )}
          disabled={!tradable || invalid || trade.isPending || !quote}
          onClick={() => trade.mutate()}
        >
          {trade.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : !tradable ? (
            market.status === "resolved" ? `Resolved ${market.resolution}` : "Trading closed"
          ) : (
            `${side === "buy" ? "Buy" : "Sell"} ${outcome === "YES" ? "Yes" : "No"}`
          )}
        </Button>

        <p className="text-center text-[11px] text-muted-foreground">
          Each share pays $1.00 if the outcome resolves in your favor. Play money only.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular">{value}</span>
    </div>
  );
}

function OutcomeButton({
  label,
  price,
  active,
  tone,
  onClick,
}: {
  label: string;
  price: number;
  active: boolean;
  tone: "yes" | "no";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-12 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors",
        active
          ? tone === "yes"
            ? "border-yes bg-yes text-white"
            : "border-no bg-no text-white"
          : "border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label} <span className="tabular">{cents(price)}</span>
    </button>
  );
}
