import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Settings2 } from "lucide-react";
import type { CoinDetail, CoinSummary, SafeUser, Trade, TradeQuote } from "@shared/schema";
import { SWAP_FEE } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { priceUsd, tokens as fmtTokens, usd } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Side = "buy" | "sell";

const EPS = 1e-9;
const MIN_BUY_USDC = 0.01;
const BUY_CHIPS = [10, 50, 100] as const;
const SELL_CHIPS = [0.25, 0.5, 0.75, 1] as const;
const SLIPPAGE_PRESETS = [0.01, 0.05, 0.1] as const;
const DEFAULT_SLIPPAGE = 0.05;
const SLIPPAGE_KEY = "nx_slippage";
const QUOTE_DEBOUNCE_MS = 150;

export interface TradePanelProps {
  coin: CoinDetail;
  className?: string;
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
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Floors to `digits` decimals so "Max" never exceeds what the user actually has. */
function floorTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.floor(n * f + 1e-9) / f;
}

function loadSlippage(): number {
  try {
    const v = Number(localStorage.getItem(SLIPPAGE_KEY));
    if (Number.isFinite(v) && v > 0 && v < 0.5) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SLIPPAGE;
}

const pctLabel = (p: number) => `${trimNumber(p * 100, 2) || "0"}%`;

export function TradePanel({ coin, className }: TradePanelProps) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, isLoading: authLoading, openLogin } = useAuth();

  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const [slippage, setSlippage] = useState<number>(loadSlippage);
  const amount = Number(raw) || 0;

  useEffect(() => {
    try {
      localStorage.setItem(SLIPPAGE_KEY, String(slippage));
    } catch {
      /* storage unavailable */
    }
  }, [slippage]);

  const owned = coin.myHolding?.tokens ?? 0;
  const balance = user?.balance ?? 0;
  const ownedValue = owned * coin.price;

  // ---- Debounced quote ------------------------------------------------------
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const canQuote = !!user && amount > 0 && (side === "sell" || amount >= MIN_BUY_USDC);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!canQuote) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/coins/${coin.ca}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ side, amount }),
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
        setQuoteError(apiErrorMessage(e, t("trade.quoteError")));
        setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // coin.price re-quotes after every live trade; t is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, coin.ca, coin.price, canQuote]);

  const minOut = useMemo(() => (quote ? quote.amountOut * (1 - slippage) : null), [quote, slippage]);

  // ---- Trade mutation -------------------------------------------------------
  const trade = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/coins/${coin.ca}/trade`, {
        side,
        amount,
        minOut: minOut !== null ? Math.max(0, minOut) : undefined,
      });
      return (await res.json()) as { trade: Trade; coin: CoinSummary; user: SafeUser };
    },
    onSuccess: (data) => {
      qc.setQueryData(["/api/me"], data.user);
      // Patch the detail immediately with the fresh summary; the refetch fills in the rest.
      qc.setQueryData<CoinDetail>([`/api/coins/${coin.ca}`], (prev) => (prev ? { ...prev, ...data.coin } : prev));
      void qc.invalidateQueries({ queryKey: [`/api/coins/${coin.ca}`] });
      void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      void qc.invalidateQueries({ queryKey: ["/api/me"] });
      setRaw("");
      const vars = { tokens: fmtTokens(data.trade.tokens), ticker: coin.ticker, usdc: usd(data.trade.usdc) };
      toast({
        title: t("trade.filled"),
        description: side === "buy" ? t("trade.boughtFor", vars) : t("trade.soldFor", vars),
      });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("trade.failed"), description: apiErrorMessage(err) });
    },
  });

  // ---- Derived UI state -----------------------------------------------------
  const exceedsBalance = side === "buy" && !!user && amount > balance + EPS;
  const exceedsOwned = side === "sell" && !!user && amount > owned + 1e-6;
  const belowMin = side === "buy" && amount > 0 && amount < MIN_BUY_USDC;
  const invalid = amount <= 0 || exceedsBalance || exceedsOwned || belowMin;

  const switchSide = (s: Side) => {
    if (s !== side) {
      setSide(s);
      setRaw("");
    }
  };

  const ctaLabel = (): ReactNode => {
    if (trade.isPending) return <Loader2 className="h-5 w-5 animate-spin" />;
    if (!user) return t("trade.loginToTrade");
    if (exceedsBalance) return t("trade.insufficient");
    if (exceedsOwned) return t("trade.notEnoughTokens");
    return side === "buy" ? t("trade.placeBuy", { ticker: coin.ticker }) : t("trade.placeSell", { ticker: coin.ticker });
  };

  const ctaDisabled = trade.isPending || (!!user && (invalid || quoting || !quote || !!quoteError));

  const onCta = () => {
    if (!user) {
      openLogin();
      return;
    }
    if (ctaDisabled) return;
    trade.mutate();
  };

  const isBuy = side === "buy";
  const feePct = pctLabel(SWAP_FEE);

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      {/* Buy / Sell tabs */}
      <div className="grid grid-cols-2 gap-1 p-2">
        {(["buy", "sell"] as Side[]).map((s) => {
          const active = side === s;
          const buy = s === "buy";
          return (
            <button
              key={s}
              type="button"
              onClick={() => switchSide(s)}
              aria-pressed={active}
              className={cn(
                "h-10 rounded-lg text-sm font-semibold transition-colors",
                active
                  ? buy
                    ? "bg-[#22c55e] text-white shadow-[0_0_20px_rgba(34,197,94,0.35)]"
                    : "bg-[#f43f5e] text-white shadow-[0_0_20px_rgba(244,63,94,0.35)]"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {buy ? t("trade.buy") : t("trade.sell")}
            </button>
          );
        })}
      </div>

      <div className="space-y-4 p-4 pt-2">
        {/* Header row: switch + slippage */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">
            {t("trade.amount")} <span className="text-foreground">({isBuy ? "USDC" : coin.ticker})</span>
          </span>
          <SlippageControl slippage={slippage} onChange={setSlippage} />
        </div>

        {/* Amount */}
        <div>
          <div className="relative">
            {isBuy && (
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-2xl font-medium text-muted-foreground">
                $
              </span>
            )}
            <input
              inputMode="decimal"
              autoComplete="off"
              value={raw}
              onChange={(e) => setRaw(sanitizeDecimal(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCta();
              }}
              placeholder="0"
              aria-label={t("trade.amount")}
              className={cn(
                "h-14 w-full rounded-lg border border-input bg-background text-3xl font-semibold tabular outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring",
                isBuy ? "pl-9 pr-20" : "pl-3 pr-24",
              )}
            />
            {!isBuy && (
              <span className="pointer-events-none absolute right-3 top-1/2 max-w-[80px] -translate-y-1/2 truncate text-sm font-semibold text-muted-foreground">
                {coin.ticker}
              </span>
            )}
            {isBuy && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
                USDC
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            {authLoading ? (
              <Skeleton className="h-3.5 w-24" />
            ) : user ? (
              <span className="tabular">
                {isBuy
                  ? `${t("trade.balance")} ${usd(balance)}`
                  : `${t("trade.youOwn")} ${fmtTokens(owned)} ${coin.ticker} (~${usd(ownedValue)})`}
              </span>
            ) : (
              <span />
            )}
            {raw && (
              <button type="button" onClick={() => setRaw("")} className="font-medium hover:text-foreground">
                {t("trade.reset")}
              </button>
            )}
          </div>

          <div className="mt-2 grid grid-cols-4 gap-2">
            {isBuy
              ? BUY_CHIPS.map((n) => (
                  <Chip key={n} onClick={() => setRaw(trimNumber(n))} active={amount === n}>
                    ${n}
                  </Chip>
                ))
              : SELL_CHIPS.map((f) => (
                  <Chip
                    key={f}
                    disabled={!user || owned <= 0}
                    onClick={() => setRaw(trimNumber(f === 1 ? owned : floorTo(owned * f, 6), 6))}
                  >
                    {Math.round(f * 100)}%
                  </Chip>
                ))}
            {isBuy && (
              <Chip disabled={!user || balance <= 0} onClick={() => setRaw(trimNumber(floorTo(balance, 2)))}>
                {t("trade.max")}
              </Chip>
            )}
          </div>
        </div>

        {/* Quote */}
        <div className="space-y-1.5 rounded-lg bg-muted/50 p-3 text-sm">
          <Row
            label={t("trade.youReceive")}
            loading={quoting}
            value={
              quote ? (
                isBuy ? (
                  <span>
                    {fmtTokens(quote.amountOut)} <span className="text-muted-foreground">{coin.ticker}</span>
                  </span>
                ) : (
                  usd(quote.amountOut)
                )
              ) : (
                "—"
              )
            }
          />
          <Row label={t("trade.fee", { percent: feePct })} loading={quoting} value={quote ? usd(quote.fee) : "—"} />
          <Row
            label={t("trade.priceImpact")}
            loading={quoting}
            value={
              quote ? (
                <span
                  className={cn(
                    "tabular",
                    Math.abs(quote.priceImpact) > 0.1 ? "text-[#f43f5e]" : Math.abs(quote.priceImpact) > 0.03 ? "text-[#fbbf24]" : "",
                  )}
                  title={`${priceUsd(quote.priceBefore)} → ${priceUsd(quote.priceAfter)}`}
                >
                  {pctLabel(Math.abs(quote.priceImpact))}
                </span>
              ) : (
                "—"
              )
            }
          />
          <Row
            label={t("trade.minReceived")}
            loading={quoting}
            value={
              quote && minOut !== null ? (
                isBuy ? (
                  <span>
                    {fmtTokens(minOut)} <span className="text-muted-foreground">{coin.ticker}</span>
                  </span>
                ) : (
                  usd(minOut)
                )
              ) : (
                "—"
              )
            }
          />
          {quoteError && <div className="pt-1 text-xs text-[#f43f5e]">{quoteError}</div>}
        </div>

        {/* CTA */}
        <Button
          type="button"
          onClick={onCta}
          disabled={ctaDisabled}
          className={cn(
            "h-12 w-full rounded-lg text-base font-semibold text-white shadow-none transition-all hover:opacity-90",
            !user
              ? "bg-primary hover:bg-primary"
              : isBuy
                ? "bg-[#22c55e] hover:bg-[#22c55e] hover:shadow-[0_0_24px_rgba(34,197,94,0.35)]"
                : "bg-[#f43f5e] hover:bg-[#f43f5e] hover:shadow-[0_0_24px_rgba(244,63,94,0.35)]",
          )}
        >
          {ctaLabel()}
        </Button>

        {user && owned > 0 && (
          <p className="text-center text-[11px] leading-snug tabular text-muted-foreground">
            {t("trade.youOwn")} {fmtTokens(owned)} {coin.ticker} (~{usd(ownedValue)})
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SlippageControl({ slippage, onChange }: { slippage: number; onChange: (v: number) => void }) {
  const t = useT();
  const [custom, setCustom] = useState("");
  const isPreset = SLIPPAGE_PRESETS.some((p) => Math.abs(p - slippage) < 1e-9);

  const applyCustom = (v: string) => {
    setCustom(v);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 50) onChange(n / 100);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium tabular text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("trade.slippage")}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t("trade.slippage")} {pctLabel(slippage)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <div>
          <div className="text-sm font-semibold">{t("trade.slippage")}</div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t("trade.slippageHint")}</p>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {SLIPPAGE_PRESETS.map((p) => (
            <Chip
              key={p}
              active={Math.abs(p - slippage) < 1e-9}
              onClick={() => {
                setCustom("");
                onChange(p);
              }}
            >
              {pctLabel(p)}
            </Chip>
          ))}
          <div className="relative">
            <input
              inputMode="decimal"
              value={custom || (isPreset ? "" : trimNumber(slippage * 100, 2))}
              onChange={(e) => applyCustom(sanitizeDecimal(e.target.value))}
              placeholder="—"
              aria-label={t("trade.slippage")}
              className={cn(
                "h-8 w-full rounded-md border bg-background pr-5 text-center text-xs font-semibold tabular outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !isPreset ? "border-primary text-primary" : "border-border text-muted-foreground",
              )}
            />
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value, loading }: { label: string; value: ReactNode; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {loading ? <Skeleton className="h-4 w-16" /> : <span className="font-medium tabular">{value}</span>}
    </div>
  );
}

function Chip({
  children,
  onClick,
  disabled,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-8 rounded-md border text-xs font-semibold tabular transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export default TradePanel;
