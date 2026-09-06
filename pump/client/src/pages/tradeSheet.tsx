import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, Delete, Loader2, Plus, Rocket, ShieldCheck } from "lucide-react";
import type { CoinDetail, ExternalTokenDetail, TradeQuote, UnsignedTx, WalletView } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { useDepositSheet } from "@/components/DepositSheet";
import { SwipeConfirm } from "@/components/SwipeConfirm";
import { useWalletTx } from "@/lib/solana";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { compactUsd, looksLikeCa, priceUsd, signedPct, tokens as fmtTokens, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/not-found";

type Side = "buy" | "sell";
type Phase = "idle" | "signing" | "confirming";

const EPS = 1e-9;
const FEE_RESERVE_SOL = 0.01;
const DEFAULT_SLIPPAGE_BPS = 500;
const PCT_CHIPS = [0.1, 0.25, 0.5] as const;
const QUOTE_DEBOUNCE_MS = 300;
const MAX_DIGITS = 12;

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

function pressDigit(raw: string, digit: string): string {
  if (digit === ".") {
    if (raw.includes(".")) return raw;
    return raw ? `${raw}.` : "0.";
  }
  if (raw === "0") return digit;
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  if (decimals >= 2) return raw; // cents precision, like a real amount field
  if (raw.replace(".", "").length >= MAX_DIGITS) return raw;
  return raw + digit;
}

/** Unified view of either one of our own coins or an external Jupiter token, in USD. */
interface Target {
  kind: "coin" | "token";
  id: string;
  ticker: string;
  imageUrl: string | null;
  verified: boolean;
  priceUsd: number;
  change24h: number;
  marketCapUsd: number;
  /** tokens the wallet currently holds */
  ownedTokens: number;
  disabled: boolean; // migrated coin: no curve to trade against here
  backHref: string;
}

function useTarget(id: string, solUsd: number): { target: Target | null; loading: boolean; notFound: boolean } {
  const valid = looksLikeCa(id);
  const coin = useQuery<CoinDetail>({
    queryKey: [`/api/coins/${id}`],
    enabled: valid,
    staleTime: 15_000,
    retry: (n, err) => !isNotFoundError(err) && n < 1,
  });
  const coinMissing = coin.isError && isNotFoundError(coin.error);
  const token = useQuery<ExternalTokenDetail>({
    queryKey: [`/api/tokens/${id}`],
    enabled: valid && coinMissing,
    staleTime: 20_000,
    retry: (n, err) => !isNotFoundError(err) && n < 1,
  });

  if (!valid) return { target: null, loading: false, notFound: true };
  if (coin.data) {
    return {
      target: {
        kind: "coin",
        id,
        ticker: coin.data.ticker,
        imageUrl: coin.data.imageUrl,
        verified: true,
        priceUsd: coin.data.priceSol * solUsd,
        change24h: coin.data.change24h,
        marketCapUsd: coin.data.marketCapSol * solUsd,
        ownedTokens: coin.data.myHolding?.tokens ?? 0,
        disabled: coin.data.curve.migrated,
        backHref: `/${id}`,
      },
      loading: false,
      notFound: false,
    };
  }
  if (token.data) {
    return {
      target: {
        kind: "token",
        id,
        ticker: token.data.symbol,
        imageUrl: token.data.icon,
        verified: token.data.verified,
        priceUsd: token.data.priceUsd,
        change24h: token.data.change24h,
        marketCapUsd: token.data.marketCapUsd,
        ownedTokens: token.data.myTokens,
        disabled: false,
        backHref: `/t/${id}`,
      },
      loading: false,
      notFound: false,
    };
  }
  if (coinMissing && token.isError && isNotFoundError(token.error)) return { target: null, loading: false, notFound: true };
  return { target: null, loading: true, notFound: false };
}

function KeypadKey({ children, onClick, "aria-label": ariaLabel }: { children: ReactNode; onClick: () => void; "aria-label"?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="tap flex h-16 items-center justify-center rounded-2xl text-3xl font-semibold text-foreground active:bg-muted/60"
    >
      {children}
    </button>
  );
}

export default function TradeSheetPage() {
  const t = useT();
  const solUsd = useSolUsd();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { user, openLogin } = useAuth();
  const { publicKey, connected, signAndSend } = useWalletTx();
  const deposit = useDepositSheet();

  const [buyMatch, buyParams] = useRoute<{ mint: string }>("/buy/:mint");
  const [, sellParams] = useRoute<{ mint: string }>("/sell/:mint");
  const side: Side = buyMatch ? "buy" : "sell";
  const id = (buyParams ?? sellParams)?.mint ?? "";

  const { target, loading, notFound } = useTarget(id, solUsd);

  const [raw, setRaw] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [submitting, setSubmitting] = useState(false);
  const amountUsd = Number(raw) || 0;

  const walletLinked = !!user?.walletAddress;
  // Signing in is enough: the account's own wallet can sign (see lib/embeddedWallet.ts).
  const canTrade = !!user && connected && !!publicKey;
  const wallet = useQuery<WalletView | null>({
    queryKey: ["/api/wallet"],
    queryFn: getQueryFn<WalletView | null>({ on401: "returnNull" }),
    enabled: walletLinked,
    staleTime: 15_000,
  });
  const balanceSol = wallet.data?.balanceSol ?? 0;
  const spendableUsd = Math.max(0, balanceSol - FEE_RESERVE_SOL) * solUsd;
  const isBuy = side === "buy";
  const ownedUsd = (target?.ownedTokens ?? 0) * (target?.priceUsd ?? 0);
  const availableUsd = isBuy ? spendableUsd : ownedUsd;

  useEffect(() => {
    document.title = `${isBuy ? t("trade.buy") : t("trade.sell")} ${target?.ticker ?? ""} · ${t("app.name")}`.trim();
  }, [isBuy, target?.ticker, t]);

  // Underlying amount the server-side quote/swap endpoints expect: SOL for a buy, tokens for a sell.
  const underlyingAmount = target
    ? isBuy
      ? amountUsd / Math.max(solUsd, 1e-9)
      : amountUsd / Math.max(target.priceUsd, 1e-9)
    : 0;

  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuote(null);
    if (!target || target.disabled || underlyingAmount <= 0) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const path = target.kind === "coin" ? `/api/coins/${target.id}/quote` : `/api/tokens/${target.id}/quote`;
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ side, amount: underlyingAmount, slippageBps: DEFAULT_SLIPPAGE_BPS }),
          credentials: "include",
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(await res.text());
        const body = (await res.json()) as TradeQuote;
        if (!ctl.signal.aborted) {
          setQuote(body);
          setQuoting(false);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [target, underlyingAmount, side]);

  if (notFound) return <NotFound title={t("coin.notFound")} hint={t("coin.notFoundHint", { app: t("app.name") })} />;

  const exceedsBalance = isBuy && walletLinked && amountUsd > spendableUsd + EPS;
  const exceedsOwned = !isBuy && walletLinked && amountUsd > ownedUsd + EPS;
  const invalid = amountUsd <= 0 || exceedsBalance || exceedsOwned;

  const onCta = async () => {
    if (!target) return;
    if (!user || !canTrade) {
      openLogin();
      return;
    }
    if (exceedsBalance) {
      deposit.open();
      return;
    }
    if (invalid || submitting || target.disabled) return;
    setSubmitting(true);
    try {
      setPhase("signing");
      const path = target.kind === "coin" ? `/api/coins/${target.id}/swap-tx` : `/api/tokens/${target.id}/swap-tx`;
      const res = await apiRequest("POST", path, {
        side,
        amount: underlyingAmount,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        wallet: publicKey,
      });
      const unsigned = (await res.json()) as UnsignedTx;
      const kind = target.kind === "coin" ? "swap" : "jupswap";
      const sent = await signAndSend(unsigned, kind, target.kind === "coin" ? target.id : undefined, () => setPhase("confirming"));
      toast({
        title: t("trade.filled"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="font-medium underline">
            {t("trade.viewOnSolscan")}
          </a>
        ),
      });
      if (target.kind === "coin") {
        void qc.invalidateQueries({ queryKey: [`/api/coins/${target.id}`] });
        void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
        void qc.invalidateQueries({ queryKey: ["/api/activity"], exact: false });
      } else {
        void qc.invalidateQueries({ queryKey: [`/api/tokens/${target.id}`] });
      }
      void qc.invalidateQueries({ queryKey: ["/api/wallet"] });
      navigate(target.backHref);
    } catch (e) {
      toast({ variant: "destructive", title: t("trade.failed"), description: apiErrorMessage(e) });
    } finally {
      setSubmitting(false);
      setPhase("idle");
    }
  };

  const ctaLabel = (): string => {
    if (!target) return t("common.loading");
    if (!user) return t("trade.loginToTrade");
    // The account has its own wallet; the only wait is while it is being set up.
    if (!connected) return t("wallet.preparing");
    if (target.disabled) return t("trade.migrated");
    // Not enough cash is not a dead end: the button becomes the way to add some.
    if (exceedsBalance) return t("home.deposit");
    if (exceedsOwned) return t("trade.notEnoughTokens");
    if (amountUsd <= 0) return t("tradeSheet.enterAmount");
    return isBuy ? t("tradeSheet.buyAmount", { amount: compactUsd(amountUsd) }) : t("tradeSheet.sellAmount", { amount: compactUsd(amountUsd) });
  };
  const ctaDisabled = submitting || !target || (canTrade && ((invalid && !exceedsBalance) || target.disabled));
  const showAsIdle = !target || amountUsd <= 0 || (canTrade && target.disabled);
  /** The order is ready to send: everything else is a plain button. */
  const readyToTrade = !!target && canTrade && !target.disabled && !invalid;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => navigate(target?.backHref ?? "/")}
          aria-label={t("common.back")}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        {loading || !target ? (
          <div className="h-10 flex-1 animate-pulse rounded-xl bg-muted" />
        ) : (
          <>
            <div className="relative shrink-0">
              {target.imageUrl ? (
                <img src={target.imageUrl} alt="" className="h-10 w-10 rounded-full bg-muted object-cover" />
              ) : (
                <div className="grid h-10 w-10 place-items-center rounded-full bg-muted text-xs font-black text-muted-foreground">
                  {target.ticker.slice(0, 2)}
                </div>
              )}
              {target.verified && (
                <span className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                  {target.kind === "coin" ? <Rocket className="h-2.5 w-2.5" /> : <ShieldCheck className="h-2.5 w-2.5" />}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-extrabold uppercase leading-tight">{target.ticker}</div>
              <div className="truncate text-xs text-muted-foreground">{compactUsd(target.marketCapUsd)} {t("coin.mcap")}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular leading-tight">{priceUsd(target.priceUsd)}</div>
              <div className={cn("text-[11px] font-semibold tabular", target.change24h >= 0 ? "text-up" : "text-down")}>
                {signedPct(target.change24h)}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Huge centred amount */}
      <div className="flex flex-1 items-center justify-center px-6">
        <div className={cn("text-6xl font-extrabold tabular", amountUsd > 0 ? "text-foreground" : "text-muted-foreground/40")}>
          ${raw || "0"}
        </div>
      </div>

      {/* Percent-of-available shortcuts */}
      <div className="grid grid-cols-4 gap-2 px-4">
        {PCT_CHIPS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={!target || availableUsd <= 0}
            onClick={() => setRaw((availableUsd * p).toFixed(2).replace(/\.?0+$/, ""))}
            className="tap h-10 rounded-xl bg-muted/60 text-sm font-bold text-foreground disabled:opacity-40"
          >
            {Math.round(p * 100)}%
          </button>
        ))}
        <button
          type="button"
          disabled={!target || availableUsd <= 0}
          onClick={() => setRaw(availableUsd.toFixed(2).replace(/\.?0+$/, ""))}
          className="tap h-10 rounded-xl bg-muted/60 text-sm font-bold text-foreground disabled:opacity-40"
        >
          {t("trade.max")}
        </button>
      </div>

      {/* Custom keypad */}
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 pt-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <KeypadKey key={d} onClick={() => setRaw((r) => pressDigit(r, d))}>
            {d}
          </KeypadKey>
        ))}
        <KeypadKey onClick={() => setRaw((r) => pressDigit(r, "."))} aria-label="decimal point">
          .
        </KeypadKey>
        <KeypadKey onClick={() => setRaw((r) => pressDigit(r, "0"))}>0</KeypadKey>
        <button
          type="button"
          onClick={() => setRaw((r) => r.slice(0, -1))}
          aria-label={t("tradeSheet.backspace")}
          className="tap flex h-16 items-center justify-center"
        >
          <span className="grid h-11 w-16 place-items-center rounded-2xl bg-foreground text-background">
            <Delete className="h-5 w-5" />
          </span>
        </button>
      </div>

      {/* Available balance + collapse toggle */}
      <div className="flex items-center justify-between px-4 pb-2 text-sm text-muted-foreground">
        <button type="button" onClick={() => navigate("/wallet")} className="tap inline-flex items-center gap-1.5">
          <span className="tabular">{t("tradeSheet.available", { amount: compactUsd(availableUsd) })}</span>
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-label={t("tradeSheet.details")}
          className="tap grid h-7 w-7 place-items-center"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", showDetails && "rotate-180")} />
        </button>
      </div>
      {showDetails && target && (
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {quoting ? (
            t("common.loading")
          ) : isBuy ? (
            t("tradeSheet.approxSol", { amount: underlyingAmount.toFixed(4) })
          ) : (
            t("tradeSheet.approxTokens", { amount: fmtTokens(underlyingAmount), ticker: target.ticker })
          )}
          {quote && ` · ${t("trade.minReceived")}: ${quote.minOut.toFixed(4)}`}
        </div>
      )}

      {/*
        CTA. Once the order is real it is a swipe, not a tap: the amount is set,
        the money is there, and the last thing between it and the market should
        take a deliberate gesture. Everything before that — sign in, add cash — is
        an ordinary button.
      */}
      <div className="safe-bottom px-4 pb-4">
        {readyToTrade ? (
          <SwipeConfirm
            label={ctaLabel()}
            tone={isBuy ? "up" : "down"}
            busy={submitting}
            onConfirm={() => void onCta()}
          />
        ) : (
          <button
            type="button"
            onClick={() => void onCta()}
            disabled={ctaDisabled}
            className={cn(
              "tap h-14 w-full rounded-2xl text-lg font-extrabold text-white transition-colors disabled:cursor-not-allowed",
              showAsIdle
                ? "bg-muted text-muted-foreground"
                : isBuy
                  ? "bg-up hover:bg-up/90"
                  : "bg-down hover:bg-down/90",
            )}
          >
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : ctaLabel()}
          </button>
        )}
      </div>
      {deposit.sheet}
    </div>
  );
}
