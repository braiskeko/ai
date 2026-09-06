import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  Copy,
  Droplets,
  ExternalLink,
  Flame,
  Globe,
  Loader2,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ExternalTokenDetail, TradeQuote, UnsignedTx, WalletView } from "@shared/schema";
import { CHAIN_LABELS, parseTokenId } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CandleChart, type ChartMode, type ChartRange } from "@/components/CandleChart";
import { PoolChart } from "@/components/TradingViewChart";
import { TokenImage } from "@/components/TokenImage";
import { WatchButton } from "@/components/WatchButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import NotFound from "@/pages/not-found";
import { apiErrorMessage, useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useWalletTx } from "@/lib/solana";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import {
  age,
  compactUsd,
  looksLikeCa,
  priceUsd,
  shortCa,
  signedPct,
  sol as fmtSolAmount,
  tokens as fmtTokens,
  usd,
  useSolUsd,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Detail page for a token Next did NOT launch: `/t/<mint>`.
 *
 * Everything on this page comes from the Jupiter aggregator through our own
 * server (`/api/tokens/...`) — there is no bonding curve, no creator and no
 * comment thread. Trading is a Jupiter route: the server builds an unsigned
 * VersionedTransaction, the wallet signs it and `/api/tx/send` (kind "jupswap")
 * relays it. Next stays non-custodial exactly as it does for its own coins.
 */

const EPS = 1e-9;
/** Left unspent so the wallet always has SOL for network fees. */
const FEE_RESERVE_SOL = 0.01;
const BUY_CHIPS = [0.1, 0.5, 1] as const;
const SELL_CHIPS = [0.25, 0.5, 0.75, 1] as const;
const SLIPPAGE_PRESETS_BPS = [100, 300, 500, 1000] as const;
const DEFAULT_SLIPPAGE_BPS = 500;
const SLIPPAGE_KEY = "nx_slippage_bps";
const QUOTE_DEBOUNCE_MS = 300;
const CHART_MODE_KEY = "nx_chart_mode";
const CHART_MODES: ReadonlySet<string> = new Set(["price", "mcap"]);
const CHART_RANGE_KEY = "nx_chart_range";
const RANGES: ReadonlySet<string> = new Set(["1H", "4H", "1D", "7D", "1M", "ALL"]);
/** Live prices; each fetch also records a price sample server-side. */
const REFRESH_MS = 10_000;

type Side = "buy" | "sell";
type Phase = "idle" | "signing" | "confirming";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

function trimNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function sanitizeDecimal(v: string): string {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

function floorTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.floor(n * f + 1e-9) / f;
}

function loadPref<T extends string>(key: string, allowed: ReadonlySet<string>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && allowed.has(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
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
const pctLabel = (p: number) => `${trimNumber(Math.abs(p) * 100, 2) || "0"}%`;

/** Normalises the free-form links Jupiter reports into absolute URLs. */
function externalUrl(kind: "website" | "twitter" | "telegram", raw: string | null): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "");
  if (kind === "twitter") return `https://x.com/${handle}`;
  if (kind === "telegram") return `https://t.me/${handle}`;
  return `https://${v}`;
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function TokenIcon({ token, size }: { token: ExternalTokenDetail; size: number }) {
  return <TokenImage src={token.icon} name={token.symbol} size={size} className="rounded-3xl shadow-lg" />;
}

function CopyMint({ mint, className }: { mint: string; className?: string }) {
  const t = useT();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      toast({ title: t("coin.copied"), description: mint });
    } catch {
      toast({ variant: "destructive", title: t("common.error"), description: t("coin.copyFailed") });
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={t("coin.copyCa")}
      aria-label={t("coin.copyCa")}
      className={cn(
        "group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
        className,
      )}
    >
      <span className="truncate tabular">{shortCa(mint, 6, 6)}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <Copy className="h-3 w-3 shrink-0 opacity-70" />}
    </button>
  );
}

/**
 * Same shape as a coin we launched (pages/coin.tsx): identity row, then the two
 * numbers that matter — price left, market cap right — so both kinds of token
 * read identically.
 */
function TokenHeader({ token }: { token: ExternalTokenDetail }) {
  const t = useT();
  const up = token.change24h >= 0;
  // The absolute move behind change24h, in dollars.
  const changeUsd = token.priceUsd - token.priceUsd / (1 + token.change24h);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/" aria-label={t("common.back")} className="tap -ml-1 shrink-0 text-muted-foreground">
          <ChevronLeft className="h-6 w-6" />
        </Link>
        <span className="relative shrink-0">
          <TokenImage src={token.icon} name={token.symbol} size={44} />
          {token.verified && (
            <BadgeCheck
              className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background text-primary"
              aria-label={t("token.verified")}
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-extrabold leading-tight tracking-tight">{token.symbol}</h1>
          <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className="truncate">{token.name}</span>
            <CopyMint mint={token.mint} className="shrink-0" />
          </div>
        </div>
        <WatchButton id={token.id} />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[40px] font-extrabold leading-none tracking-tight tabular">{priceUsd(token.priceUsd)}</div>
          <div className={cn("mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[15px] font-semibold tabular", up ? "text-up" : "text-down")}>
            <span className="align-[0.15em] text-[9px]">{up ? "\u25b2" : "\u25bc"}</span>
            <span>{priceUsd(Math.abs(changeUsd))}</span>
            <span>({signedPct(token.change24h)})</span>
            <span className="font-medium text-muted-foreground">24h</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[26px] font-bold leading-tight tabular">{compactUsd(token.marketCapUsd)}</div>
          <div className="text-sm text-muted-foreground">{t("coin.mcap")}</div>
        </div>
      </div>
    </section>
  );
}

function HeroStat({ label, value, icon: Icon, className }: { label: string; value: string; icon?: LucideIcon; className?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={cn("inline-flex items-center gap-1 text-base font-bold tabular leading-tight", className)}>
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit + links
// ---------------------------------------------------------------------------

function AuditBadge({ state, yes, no, unknown }: { state: boolean | null; yes: string; no: string; unknown: string }) {
  if (state === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">
        <ShieldQuestion className="h-3.5 w-3.5" />
        {unknown}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold",
        state ? "border-up/40 bg-up/10 text-up" : "border-down/40 bg-down/10 text-down",
      )}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      {state ? yes : no}
    </span>
  );
}

function AuditCard({ token }: { token: ExternalTokenDetail }) {
  const t = useT();
  const { audit } = token;
  const links: { key: string; label: string; icon: LucideIcon; href: string }[] = [
    { key: "website", label: t("coin.website"), icon: Globe, href: externalUrl("website", token.links.website) },
    { key: "twitter", label: t("coin.twitter"), icon: ExternalLink, href: externalUrl("twitter", token.links.twitter) },
    { key: "telegram", label: t("coin.telegram"), icon: Send, href: externalUrl("telegram", token.links.telegram) },
  ].filter((l) => !!l.href);

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-bold">{t("token.audit")}</h2>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">{t("token.auditHint")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <AuditBadge
          state={audit.mintAuthorityDisabled}
          yes={t("token.mintDisabled")}
          no={t("token.mintEnabled")}
          unknown={t("token.mintUnknown")}
        />
        <AuditBadge
          state={audit.freezeAuthorityDisabled}
          yes={t("token.freezeDisabled")}
          no={t("token.freezeEnabled")}
          unknown={t("token.freezeUnknown")}
        />
        {audit.topHoldersPercent !== null && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {t("token.topHolders", { percent: pctLabel(audit.topHoldersPercent) })}
          </span>
        )}
      </div>

      <div className="mt-4 divide-y divide-border border-t border-border pt-1">
        {token.pool?.dex && <DetailRow label={t("token.pool")} value={token.pool.dex} />}
        {token.organicScore > 0 && (
          <DetailRow label={t("token.organicScore")} value={`${Math.round(token.organicScore)}/100`} />
        )}
        <DetailRow
          label={`${t("coin.buys")} / ${t("coin.sells")}`}
          value={
            <span>
              <span className="text-up">{token.buys24h}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-down">{token.sells24h}</span>
            </span>
          }
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {links.map(({ key, label, icon: Icon, href }) => (
          <ExternalPill key={key} href={href} icon={Icon} label={label} />
        ))}
        <ExternalPill href={token.explorerUrl} icon={ExternalLink} label={t("token.viewOnSolscan")} />
        <ExternalPill href={token.jupiterUrl} icon={ExternalLink} label={t("token.viewOnJupiter")} />
      </div>
    </section>
  );
}

function ExternalPill({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-semibold text-foreground/90 transition-colors hover:border-primary/40 hover:text-primary"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 font-semibold tabular">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trade panel (Jupiter route)
// ---------------------------------------------------------------------------

function ExternalTradePanel({ token, className }: { token: ExternalTokenDetail; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const solUsd = useSolUsd();
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
  const owned = token.myTokens;
  const ownedValueUsd = owned * token.priceUsd;

  // ---- Debounced quote ----------------------------------------------------
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (amount <= 0) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tokens/${token.mint}/quote`, {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, token.mint, slippageBps]);

  const exceedsBalance = side === "buy" && walletLinked && amount > spendableSol + EPS;
  const exceedsOwned = side === "sell" && walletLinked && owned > 0 && amount > owned + 1e-6;
  const invalid = amount <= 0 || exceedsBalance || exceedsOwned;
  const isBuy = side === "buy";

  const switchSide = (s: Side) => {
    if (s === side) return;
    setSide(s);
    setRaw("");
  };

  const ctaLabel = (): ReactNode => {
    if (submitting) return <Loader2 className="h-5 w-5 animate-spin" />;
    if (!user) return t("trade.loginToTrade");
    // The account has its own wallet; the only wait is while it is being set up.
    if (!connected) return t("wallet.preparing");
    if (exceedsBalance) return t("trade.insufficient");
    if (exceedsOwned) return t("trade.notEnoughTokens");
    return isBuy ? t("trade.placeBuy", { ticker: token.symbol }) : t("trade.placeSell", { ticker: token.symbol });
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
      const res = await apiRequest("POST", `/api/tokens/${token.mint}/swap-tx`, {
        side,
        amount,
        slippageBps,
        wallet: publicKey,
      });
      const unsigned = (await res.json()) as UnsignedTx;
      const sent = await signAndSend(unsigned, "jupswap", token.mint, () => setPhase("confirming"));
      toast({
        title: t("trade.filled"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="font-medium underline">
            {t("trade.viewOnSolscan")}
          </a>
        ),
      });
      setRaw("");
      void qc.invalidateQueries({ queryKey: [`/api/tokens/${token.chain}/${token.mint}`] });
      void qc.invalidateQueries({ queryKey: ["/api/wallet"] });
    } catch (e) {
      toast({ variant: "destructive", title: t("trade.failed"), description: apiErrorMessage(e) });
    } finally {
      setSubmitting(false);
      setPhase("idle");
    }
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
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
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">
            {t("trade.amount")} <span className="text-foreground">({isBuy ? "SOL" : token.symbol})</span>
          </span>
          <SlippageControl slippageBps={slippageBps} onChange={setSlippageBps} />
        </div>

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
              {isBuy ? "SOL" : token.symbol}
            </span>
          </div>

          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            {authLoading ? (
              <Skeleton className="h-3.5 w-24" />
            ) : walletLinked ? (
              <span className="tabular">
                {isBuy
                  ? `${t("trade.balance")} ${fmtSolAmount(balanceSol)} (${usd(balanceSol, solUsd)})`
                  : `${t("trade.youOwn")} ${fmtTokens(owned)} ${token.symbol} (~${compactUsd(ownedValueUsd)})`}
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

        <div className="space-y-1.5 rounded-lg bg-muted/50 p-3 text-sm">
          <QuoteRow
            label={t("trade.youReceive")}
            loading={quoting}
            value={
              quote ? (
                isBuy ? (
                  <span>
                    {fmtTokens(quote.amountOut)} <span className="text-muted-foreground">{token.symbol}</span>
                  </span>
                ) : (
                  <span>{fmtSolAmount(quote.amountOut)}</span>
                )
              ) : (
                "—"
              )
            }
          />
          <QuoteRow
            label={t("trade.priceImpact")}
            loading={quoting}
            value={
              quote ? (
                <span
                  className={cn(
                    "tabular",
                    Math.abs(quote.priceImpact) > 0.1 ? "text-down" : Math.abs(quote.priceImpact) > 0.03 ? "text-gold" : "",
                  )}
                >
                  {pctLabel(quote.priceImpact)}
                </span>
              ) : (
                "—"
              )
            }
          />
          <QuoteRow
            label={t("trade.minReceived")}
            loading={quoting}
            value={
              quote ? (
                isBuy ? (
                  <span>
                    {fmtTokens(quote.minOut)} <span className="text-muted-foreground">{token.symbol}</span>
                  </span>
                ) : (
                  <span>{fmtSolAmount(quote.minOut)}</span>
                )
              ) : (
                "—"
              )
            }
          />
          {quote && quote.feeSol > 0 && (
            <QuoteRow label={t("token.platformFee")} loading={quoting} value={fmtSolAmount(quote.feeSol)} />
          )}
          {quoteError && <div className="pt-1 text-xs text-down">{quoteError}</div>}
        </div>

        <Button
          type="button"
          onClick={() => void onCta()}
          disabled={ctaDisabled}
          className={cn(
            "h-12 w-full rounded-lg text-base font-semibold text-white shadow-none transition-all hover:opacity-90",
            !canTrade
              ? "bg-primary hover:bg-primary"
              : isBuy
                ? "bg-[#22c55e] hover:bg-[#22c55e]"
                : "bg-[#f43f5e] hover:bg-[#f43f5e]",
          )}
        >
          {ctaLabel()}
        </Button>

        {submitting && (
          <p className="text-center text-xs text-muted-foreground">
            {phase === "signing" ? t("trade.signing") : t("trade.confirming")}
          </p>
        )}

        <p className="text-center text-[11px] leading-snug text-muted-foreground">{t("token.routedByJupiter")}</p>
      </div>
    </div>
  );
}

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

function QuoteRow({ label, value, loading }: { label: string; value: ReactNode; loading?: boolean }) {
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

/**
 * A token on a chain Next cannot swap on yet. Saying so — and pointing at a place
 * that can — beats a Buy button that would fail.
 */
function OffChainNotice({ token }: { token: ExternalTokenDetail }) {
  const t = useT();
  return (
    <section className="rounded-3xl border border-border bg-card p-5 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-foreground">
        <ExternalLink className="h-5 w-5" />
      </div>
      <h2 className="mt-3 text-base font-bold">{t("token.notTradableTitle", { chain: CHAIN_LABELS[token.chain] })}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("token.notTradableHint")}</p>
      <Button asChild className="mt-4 w-full rounded-xl font-semibold">
        <a href={token.jupiterUrl} target="_blank" rel="noopener noreferrer">
          {t("token.openMarket")}
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function TokenSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <div className="surface p-4 sm:p-5">
        <div className="flex gap-4">
          <Skeleton className="h-20 w-20 shrink-0 rounded-2xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Skeleton className="h-[380px] w-full rounded-2xl" />
        <Skeleton className="h-[420px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

export default function TokenPage() {
  const t = useT();
  const [, navigate] = useLocation();
  const { mint = "" } = useParams<{ mint: string }>();
  // `/t/<mint>` is Solana; `/t/<chain>:<address>` is any other chain we list.
  const parsed = parseTokenId(decodeURIComponent(mint));
  const valid = parsed !== null;
  const apiPath = parsed ? `/api/tokens/${parsed.chain}/${parsed.address}` : "";

  const token = useQuery<ExternalTokenDetail>({
    queryKey: [apiPath],
    enabled: valid,
    staleTime: 5_000,
    // Each refetch also samples the price server-side, which is what feeds the chart.
    refetchInterval: REFRESH_MS,
    retry: (failureCount, err) => !isNotFoundError(err) && failureCount < 2,
  });

  const [range, setRange] = useState<ChartRange>(() => loadPref(CHART_RANGE_KEY, RANGES, "1H"));
  const [mode, setMode] = useState<ChartMode>(() => loadPref(CHART_MODE_KEY, CHART_MODES, "mcap"));
  const onModeChange = useCallback((m: ChartMode) => {
    setMode(m);
    try {
      localStorage.setItem(CHART_MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const onRangeChange = useCallback((r: ChartRange) => {
    setRange(r);
    try {
      localStorage.setItem(CHART_RANGE_KEY, r);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const data = token.data;
  const title = useMemo(() => (data ? `${data.name} ($${data.symbol}) · ${t("app.name")}` : t("app.name")), [data, t]);
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);

  if (!valid || (token.isError && isNotFoundError(token.error))) {
    return <NotFound title={t("token.notFound")} hint={t("token.notFoundHint")} />;
  }

  return (
    <PageShell wide noHeader className="pt-4 pb-nav-actions md:pb-10">
      {token.isLoading || !data ? (
        token.isError ? (
          <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">😵</div>
            <h1 className="mt-4 text-lg font-bold">{t("token.loadError")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{apiErrorMessage(token.error, t("common.error"))}</p>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" className="rounded-lg" onClick={() => void token.refetch()}>
                <RefreshCw className={cn("h-4 w-4", token.isFetching && "animate-spin")} />
                {t("common.retry")}
              </Button>
              <Button asChild className="rounded-lg font-semibold">
                <Link href="/">{t("common.goHome")}</Link>
              </Button>
            </div>
          </div>
        ) : (
          <TokenSkeleton />
        )
      ) : (
        <div className="space-y-6 pb-36 lg:pb-0">
          <TokenHeader token={data} />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1fr)_400px]">
            <section className="min-w-0 lg:col-start-1 lg:row-start-1">
              {data.chartEmbedUrl ? (
                <PoolChart
                  src={data.chartEmbedUrl}
                  height={420}
                  className="-mx-4 w-[calc(100%+2rem)] overflow-hidden sm:mx-0 sm:w-full sm:rounded-3xl"
                />
              ) : (
              <CandleChart
                candles={data.candles}
                trades={[]}
                ticker={data.symbol}
                unit="USD"
                supply={data.supply}
                mode={mode}
                onModeChange={onModeChange}
                range={range}
                onRangeChange={onRangeChange}
                emptyMessage={data.chartSource === "none" ? t("chart.waitingCandles") : undefined}
                className="-mx-4 sm:mx-0 sm:rounded-3xl sm:border sm:border-border sm:bg-card"
              />
              )}
            </section>

            <aside className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-start">
              {data.tradable ? (
                <div className="hidden lg:block">
                  <ExternalTradePanel token={data} />
                </div>
              ) : (
                <OffChainNotice token={data} />
              )}
              <AuditCard token={data} />
            </aside>
          </div>
        </div>
      )}

      {/* Mobile: Buy/Sell push the full-screen keypad; Sell only when there is a position. */}
      {data && data.tradable && (
        <div className="fixed inset-x-0 bottom-[calc(5.6rem+env(safe-area-inset-bottom,0px))] z-30 px-4 lg:hidden">
          <div className="mx-auto flex max-w-7xl gap-2.5">
            <Button
              type="button"
              onClick={() => navigate(`/buy/${data.mint}`)}
              className="tap h-12 flex-1 rounded-full bg-up text-base font-bold text-white hover:bg-up/90"
            >
              {t("trade.buy")}
            </Button>
            {data.myTokens > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/sell/${data.mint}`)}
                className="tap h-12 flex-1 rounded-full border-down/50 text-base font-bold text-down hover:bg-down/10"
              >
                {t("trade.sell")}
              </Button>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
