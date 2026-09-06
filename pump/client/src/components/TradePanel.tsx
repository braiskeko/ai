import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Settings2 } from "lucide-react";
import type { CoinDetail, TradeQuote, UnsignedTx, WalletView } from "@shared/schema";
import { SWAP_FEE } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { useT } from "@/i18n";
import { useWalletTx } from "@/lib/solana";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Side = "buy" | "sell";
type Phase = "idle" | "signing" | "confirming";

const EPS = 1e-9;
/** Left unspent so the wallet always has SOL for network + swap fees. */
const FEE_RESERVE_SOL = 0.01;
const BUY_CHIPS = [0.1, 0.5, 1] as const;
const SELL_CHIPS = [0.25, 0.5, 0.75, 1] as const;
/** Basis points: 1% / 3% / 5% / 10%. */
const SLIPPAGE_PRESETS_BPS = [100, 300, 500, 1000] as const;
const DEFAULT_SLIPPAGE_BPS = 500;
const SLIPPAGE_KEY = "nx_slippage_bps";
const QUOTE_DEBOUNCE_MS = 300;

export interface TradePanelProps {
  coin: CoinDetail;
  className?: string;
}

// ---------------------------------------------------------------------------
// Local formatting — lib/format.ts is owned by another agent and quote/SOL
// figures need only a handful of small helpers here.
// ---------------------------------------------------------------------------

function trimNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function fmtSol(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "0";
  const s = Math.abs(n).toFixed(digits).replace(/\.?0+$/, "");
  return (n < 0 ? "-" : "") + (s || "0");
}

function fmtUsd(sol: number, solUsd: number): string {
  const usd = sol * solUsd;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) >= 1000 ? 0 : 2,
  }).format(usd);
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (s: string) => s.replace(/\.?0+$/, "");
  if (abs >= 1e9) return `${sign}${trim((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}${trim((abs / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `${sign}${trim((abs / 1e3).toFixed(2))}K`;
  return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(abs)}`;
}

/** Price per token in SOL, tiny values kept readable. */
function fmtPriceSol(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0";
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toExponential(3);
}

function sanitizeDecimal(v: string): string {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

/** Floors to `digits` decimals so "Max" never exceeds what the user actually has. */
function floorTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.floor(n * f + 1e-9) / f;
}

function loadSlippageBps(): number {
  try {
    const v = Number(localStorage.getItem(SLIPPAGE_KEY));
    if (Number.isInteger(v) && v >= 0 && v <= 5000) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SLIPPAGE_BPS;
}

const bpsToPctLabel = (bps: number) => `${trimNumber(bps / 100, 2) || "0"}%`;
const pctLabel = (p: number) => `${trimNumber(p * 100, 2) || "0"}%`;

export function TradePanel({ coin, className }: TradePanelProps) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const config = useConfig();
  const solUsd = config?.solUsd ?? 0;
  const { publicKey, connected, signAndSend } = useWalletTx();

  const walletLinked = !!user?.walletAddress;
  // Signing in is enough: the account's own wallet can sign (see lib/embeddedWallet.ts).
  const canTrade = !!user && connected && !!publicKey;

  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(loadSlippageBps);
  const [phase, setPhase] = useState<Phase>("idle");
  const [submitting, setSubmitting] = useState(false);
  const amount = Number(raw) || 0;

  useEffect(() => {
    try {
      localStorage.setItem(SLIPPAGE_KEY, String(slippageBps));
    } catch {
      /* storage unavailable */
    }
  }, [slippageBps]);

  const { data: walletView } = useQuery<WalletView | null>({
    queryKey: ["/api/wallet"],
    queryFn: getQueryFn<WalletView | null>({ on401: "returnNull" }),
    enabled: walletLinked,
    staleTime: 15_000,
  });
  const balanceSol = walletView?.balanceSol ?? 0;
  const spendableSol = Math.max(0, balanceSol - FEE_RESERVE_SOL);

  const owned = coin.myHolding?.tokens ?? 0;
  const ownedValueSol = owned * coin.curve.priceSol;
  const migrated = coin.curve.migrated;

  // ---- Debounced quote ------------------------------------------------------
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const canQuote = !migrated && amount > 0;

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
          body: JSON.stringify({ side, amount, slippageBps }),
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
    // coin.curve.priceSol re-quotes after every live trade; t is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, coin.ca, slippageBps, canQuote, coin.curve.priceSol]);

  // ---- Derived UI state -----------------------------------------------------
  const exceedsBalance = side === "buy" && walletLinked && amount > spendableSol + EPS;
  const exceedsOwned = side === "sell" && walletLinked && amount > owned + 1e-6;
  const invalid = amount <= 0 || exceedsBalance || exceedsOwned;

  const switchSide = (s: Side) => {
    if (s !== side) {
      setSide(s);
      setRaw("");
    }
  };

  const ctaLabel = (): ReactNode => {
    if (submitting) return <Loader2 className="h-5 w-5 animate-spin" />;
    if (!user) return t("trade.loginToTrade");
    // The account has its own wallet; the only wait is while it is being set up.
    if (!connected) return t("wallet.preparing");
    if (exceedsBalance) return t("trade.insufficient");
    if (exceedsOwned) return t("trade.notEnoughTokens");
    return side === "buy" ? t("trade.placeBuy", { ticker: coin.ticker }) : t("trade.placeSell", { ticker: coin.ticker });
  };

  const ctaDisabled = submitting || (canTrade && (invalid || quoting || !quote || !!quoteError));

  const onCta = async () => {
    if (!user || !canTrade) {
      openLogin();
      return;
    }
    if (ctaDisabled) return;
    setSubmitting(true);
    try {
      setPhase("signing");
      const res = await apiRequest("POST", `/api/coins/${coin.ca}/swap-tx`, {
        side,
        amount,
        slippageBps,
        wallet: publicKey,
      });
      const unsigned = (await res.json()) as UnsignedTx;
      const sent = await signAndSend(unsigned, "swap", coin.ca, () => setPhase("confirming"));
      toast({
        title: t("trade.filled"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="font-medium underline">
            {t("trade.viewOnSolscan")}
          </a>
        ),
      });
      setRaw("");
      void qc.invalidateQueries({ queryKey: [`/api/coins/${coin.ca}`] });
      void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      void qc.invalidateQueries({ queryKey: ["/api/wallet"] });
      void qc.invalidateQueries({ queryKey: ["/api/activity"], exact: false });
    } catch (e) {
      toast({ variant: "destructive", title: t("trade.failed"), description: apiErrorMessage(e) });
    } finally {
      setSubmitting(false);
      setPhase("idle");
    }
  };

  const isBuy = side === "buy";
  const feePct = pctLabel(SWAP_FEE);

  if (migrated) {
    return (
      <div className={cn("rounded-xl border border-border bg-card p-5 text-center", className)}>
        <p className="text-sm font-bold">{t("trade.migrated")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("trade.migratedHint")}</p>
        {coin.curve.dammPool && (
          <a
            href={`https://app.meteora.ag/dammv2/${coin.curve.dammPool}`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("trade.viewOnMeteora")}
          </a>
        )}
      </div>
    );
  }

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
        {/* Header row: unit + slippage */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">
            {t("trade.amount")} <span className="text-foreground">({isBuy ? "SOL" : coin.ticker})</span>
          </span>
          <SlippageControl slippageBps={slippageBps} onChange={setSlippageBps} />
        </div>

        {/* Amount */}
        <div>
          <div className="relative">
            <input
              inputMode="decimal"
              autoComplete="off"
              value={raw}
              onChange={(e) => setRaw(sanitizeDecimal(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onCta();
              }}
              placeholder="0"
              aria-label={t("trade.amount")}
              className={cn(
                "h-14 w-full rounded-lg border border-input bg-background pl-3 text-3xl font-semibold tabular outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring",
                isBuy ? "pr-16" : "pr-24",
              )}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 max-w-[80px] -translate-y-1/2 truncate text-sm font-semibold text-muted-foreground">
              {isBuy ? "SOL" : coin.ticker}
            </span>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            {authLoading ? (
              <Skeleton className="h-3.5 w-24" />
            ) : walletLinked ? (
              <span className="tabular">
                {isBuy
                  ? `${t("trade.balance")} ${fmtSol(balanceSol)} SOL (${fmtUsd(balanceSol, solUsd)})`
                  : `${t("trade.youOwn")} ${fmtTokens(owned)} ${coin.ticker} (~${fmtUsd(ownedValueSol, solUsd)})`}
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
            {isBuy ? (
              <>
                {BUY_CHIPS.map((n) => (
                  <Chip key={n} onClick={() => setRaw(trimNumber(n))} active={Math.abs(amount - n) < EPS}>
                    {n} SOL
                  </Chip>
                ))}
                <Chip disabled={!walletLinked || spendableSol <= 0} onClick={() => setRaw(trimNumber(spendableSol))}>
                  {t("trade.max")}
                </Chip>
              </>
            ) : (
              SELL_CHIPS.map((f) => (
                <Chip
                  key={f}
                  disabled={!walletLinked || owned <= 0}
                  onClick={() => setRaw(trimNumber(f === 1 ? owned : floorTo(owned * f, 6), 6))}
                >
                  {Math.round(f * 100)}%
                </Chip>
              ))
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
                  <span>
                    {fmtSol(quote.amountOut)} <span className="text-muted-foreground">SOL</span>
                  </span>
                )
              ) : (
                "—"
              )
            }
          />
          <Row
            label={t("trade.fee", { percent: feePct })}
            loading={quoting}
            value={quote ? `${fmtSol(quote.feeSol)} SOL` : "—"}
          />
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
                  title={`${fmtPriceSol(quote.priceBeforeSol)} → ${fmtPriceSol(quote.priceAfterSol)} SOL`}
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
              quote ? (
                isBuy ? (
                  <span>
                    {fmtTokens(quote.minOut)} <span className="text-muted-foreground">{coin.ticker}</span>
                  </span>
                ) : (
                  <span>
                    {fmtSol(quote.minOut)} <span className="text-muted-foreground">SOL</span>
                  </span>
                )
              ) : (
                "—"
              )
            }
          />
          {quoteError && <div className="pt-1 text-xs text-[#f43f5e]">{quoteError}</div>}
        </div>

        {quote?.completesCurve && (
          <div className="rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary">{t("trade.completesCurve")}</div>
        )}

        {/* CTA */}
        <Button
          type="button"
          onClick={() => void onCta()}
          disabled={ctaDisabled}
          className={cn(
            "h-12 w-full rounded-lg text-base font-semibold text-white shadow-none transition-all hover:opacity-90",
            !canTrade
              ? "bg-primary hover:bg-primary"
              : isBuy
                ? "bg-[#22c55e] hover:bg-[#22c55e] hover:shadow-[0_0_24px_rgba(34,197,94,0.35)]"
                : "bg-[#f43f5e] hover:bg-[#f43f5e] hover:shadow-[0_0_24px_rgba(244,63,94,0.35)]",
          )}
        >
          {ctaLabel()}
        </Button>

        {submitting && (
          <p className="text-center text-xs text-muted-foreground">
            {phase === "signing" ? t("trade.signing") : t("trade.confirming")}
          </p>
        )}

        {walletLinked && owned > 0 && (
          <p className="text-center text-[11px] leading-snug tabular text-muted-foreground">
            {t("trade.youOwn")} {fmtTokens(owned)} {coin.ticker} (~{fmtUsd(ownedValueSol, solUsd)})
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SlippageControl({ slippageBps, onChange }: { slippageBps: number; onChange: (bps: number) => void }) {
  const t = useT();
  const [custom, setCustom] = useState("");
  const isPreset = SLIPPAGE_PRESETS_BPS.some((p) => p === slippageBps);

  const applyCustom = (v: string) => {
    setCustom(v);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n <= 50) onChange(Math.round(n * 100));
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
          {t("trade.slippage")} {bpsToPctLabel(slippageBps)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <div>
          <div className="text-sm font-semibold">{t("trade.slippage")}</div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t("trade.slippageHint")}</p>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {SLIPPAGE_PRESETS_BPS.map((bps) => (
            <Chip
              key={bps}
              active={bps === slippageBps}
              onClick={() => {
                setCustom("");
                onChange(bps);
              }}
            >
              {bpsToPctLabel(bps)}
            </Chip>
          ))}
          <div className="relative">
            <input
              inputMode="decimal"
              value={custom || (isPreset ? "" : trimNumber(slippageBps / 100, 2))}
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
