import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  Globe,
  GraduationCap,
  Info,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { CoinDetail, UnsignedTx } from "@shared/schema";
import { CREATOR_FEE_SHARE, GRADUATION_MCAP_USD, SWAP_FEE, TOTAL_SUPPLY } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CandleChart, type ChartInterval, type ChartMode } from "@/components/CandleChart";
import { TradePanel } from "@/components/TradePanel";
import { Comments } from "@/components/Comments";
import { PublicAvatar } from "@/components/TradesTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import NotFound from "@/pages/not-found";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useWalletTx } from "@/lib/solana";
import {
  age,
  compactUsd,
  dateShort,
  looksLikeCa,
  priceSol,
  priceUsd,
  shortCa,
  signedPct,
  signedUsd,
  sol,
  tokens as fmtTokens,
  usd,
  useSolUsd,
} from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const CHART_MODE_KEY = "nx_chart_mode";
const CHART_INTERVAL_KEY = "nx_chart_interval";
const INTERVALS: ReadonlySet<string> = new Set(["1m", "5m", "15m", "1h"]);

function loadPref<T extends string>(key: string, allowed: ReadonlySet<string>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && allowed.has(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

const pctText = (p: number, digits = 1) => `${(p * 100).toFixed(digits)}%`;
const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

/** Re-renders every `ms` so relative times ("3m ago") stay fresh. */
function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Normalises the free-form links stored on a coin into absolute URLs. */
function externalUrl(kind: "website" | "twitter" | "telegram", raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "");
  if (kind === "twitter") return `https://x.com/${handle}`;
  if (kind === "telegram") return `https://t.me/${handle}`;
  return `https://${v}`;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard button
// ---------------------------------------------------------------------------

function CopyCa({ ca, className }: { ca: string; className?: string }) {
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
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ca);
      } else {
        const ta = document.createElement("textarea");
        ta.value = ca;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      toast({ title: t("coin.copied"), description: ca });
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
      <span className="truncate tabular">{shortCa(ca, 6, 6)}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <Copy className="h-3 w-3 shrink-0 opacity-70 group-hover:opacity-100" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CoinHeader({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const solUsd = useSolUsd();
  useTick(30_000);
  const up = coin.change24h >= 0;
  const progress = Math.max(0, Math.min(1, coin.progress));
  const graduated = coin.curve.completed;

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("surface relative overflow-hidden p-4 sm:p-6", graduated && "border-violet/40")}
    >
      <div className="flex items-center gap-4">
        <img
          src={coin.imageUrl}
          alt=""
          decoding="async"
          className="h-20 w-20 shrink-0 rounded-3xl bg-muted object-cover shadow-lg sm:h-24 sm:w-24"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="truncate text-xl font-extrabold tracking-tight sm:text-2xl">{coin.name}</h1>
            <span className="text-sm font-semibold text-muted-foreground">${coin.ticker}</span>
            {graduated && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet/15 px-2 py-0.5 text-[11px] font-bold text-violet">
                <GraduationCap className="h-3 w-3" />
                {t("coin.graduated")}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{t("coin.createdBy")}</span>
            <Link
              href={`/u/${encodeURIComponent(coin.creator.username)}`}
              className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground/80 hover:text-primary hover:underline"
            >
              <PublicAvatar user={coin.creator} size={16} />
              <span className="truncate">@{coin.creator.username}</span>
            </Link>
            <span className="inline-flex items-center gap-1" title={new Date(coin.createdAt).toLocaleString()}>
              <Clock className="h-3 w-3" />
              {t("coin.ago", { time: age(coin.createdAt) })}
            </span>
            <CopyCa ca={coin.ca} className="hidden sm:inline-flex" />
          </div>
        </div>
      </div>

      <CopyCa ca={coin.ca} className="mt-3 sm:hidden" />

      {/* Big USD price — the hero number */}
      <div className="mt-5">
        <div className="label">{t("coin.price")}</div>
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <span className="stat text-4xl leading-none sm:text-5xl">{priceUsd(coin.priceSol * solUsd)}</span>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-sm font-bold tabular",
              up ? "bg-up/15 text-up" : "bg-down/15 text-down",
            )}
          >
            {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
            {signedPct(coin.change24h)}
          </span>
        </div>
        <div className="mt-0.5 text-xs tabular text-muted-foreground">{priceSol(coin.priceSol)}</div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border/70 pt-4">
        <div>
          <div className="label">{t("coin.mcap")}</div>
          <div className="text-base font-bold tabular leading-tight text-primary">{compactUsd(coin.marketCapSol * solUsd)}</div>
        </div>
        <div>
          <div className="label">{t("coin.volume")}</div>
          <div className="text-base font-bold tabular leading-tight">{compactUsd(coin.volumeSol * solUsd)}</div>
        </div>
        <div>
          <div className="label">{t("coin.holders")}</div>
          <div className="inline-flex items-center gap-1 text-base font-bold tabular leading-tight">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            {coin.holders}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
            {t("coin.progress")}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex text-muted-foreground hover:text-foreground" aria-label={t("coin.progressHint", { mcap: compactUsd(GRADUATION_MCAP_USD) })}>
                  <Info className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {t("coin.progressHint", { mcap: compactUsd(GRADUATION_MCAP_USD) })}
              </TooltipContent>
            </Tooltip>
          </span>
          <span className={cn("tabular font-semibold", graduated ? "text-violet" : "text-foreground")}>
            {graduated ? t("coin.graduated") : t("coin.solToGraduate", { amount: sol(coin.curve.solToGraduate) })}
          </span>
        </div>
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label={t("coin.progress")}
        >
          <motion.div
            className={cn("h-full rounded-full", graduated ? "bg-violet" : "bg-primary")}
            initial={false}
            animate={{ width: `${Math.max(2, progress * 100)}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular text-muted-foreground">
          <span>{compactUsd(coin.marketCapSol * solUsd)}</span>
          <span>{compactUsd(GRADUATION_MCAP_USD)}</span>
        </div>
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Side cards: stats, my position, creator claim, about & links
// ---------------------------------------------------------------------------

function StatRow({ icon: Icon, label, value, valueClass }: { icon?: LucideIcon; label: string; value: ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("shrink-0 font-semibold tabular", valueClass)}>{value}</span>
    </div>
  );
}

function StatsCard({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const solUsd = useSolUsd();
  const curveShare = Math.max(0, Math.min(1, coin.curve.baseReserve / TOTAL_SUPPLY));
  const total = coin.buys + coin.sells;
  const buyShare = total > 0 ? coin.buys / total : 0.5;

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-bold">{t("coin.stats")}</h2>
      <div className="mt-1 divide-y divide-border">
        <StatRow icon={Users} label={t("coin.holders")} value={count(coin.holders)} />
        <StatRow icon={Activity} label={t("coin.volume")} value={compactUsd(coin.volumeSol * solUsd)} />
        <StatRow icon={MessageCircle} label={t("comments.title")} value={count(Math.max(coin.comments, coin.commentsList.length))} />
        <div className="py-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {t("coin.buys")} / {t("coin.sells")}
            </span>
            <span className="font-semibold tabular">
              <span className="text-up">{count(coin.buys)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-down">{count(coin.sells)}</span>
            </span>
          </div>
          <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
            <span className="h-full bg-up transition-[width] duration-500" style={{ width: `${buyShare * 100}%` }} />
            <span className="h-full bg-down transition-[width] duration-500" style={{ width: `${(1 - buyShare) * 100}%` }} />
          </div>
        </div>
        <StatRow label={t("coin.supplyInCurveLabel")} value={pctText(curveShare)} />
        <StatRow label={t("coin.solInCurve")} value={sol(coin.curve.quoteReserveSol)} />
        <StatRow label={t("coin.totalSupply")} value={fmtTokens(TOTAL_SUPPLY)} />
        <StatRow
          label={t("coin.fee")}
          value={
            <span>
              {pctText(SWAP_FEE)} <span className="font-normal text-muted-foreground">· {t("coin.feeToCreator", { share: pctText(CREATOR_FEE_SHARE, 0) })}</span>
            </span>
          }
        />
        <StatRow icon={Clock} label={t("coin.created")} value={dateShort(coin.createdAt)} />
      </div>
    </section>
  );
}

function MyPositionCard({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const solUsd = useSolUsd();
  const { user } = useAuth();
  const h = coin.myHolding;
  if (!user || !h || h.tokens <= 1e-9) return null;

  const valueSol = h.tokens * coin.priceSol;
  const unrealizedSol = valueSol - h.costBasisSol;
  const pnlPct = h.costBasisSol > 0 ? unrealizedSol / h.costBasisSol : 0;
  const share = h.tokens / TOTAL_SUPPLY;

  return (
    <section className="rounded-3xl border border-primary/30 bg-primary/5 p-4">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-bold">
        <Wallet className="h-4 w-4 text-primary" />
        {t("coin.myPosition")}
      </h2>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("trade.youOwn")}</div>
          <div className="text-xl font-extrabold tabular leading-tight">
            {fmtTokens(h.tokens)} <span className="text-sm font-semibold text-muted-foreground">{coin.ticker}</span>
          </div>
          <div className="text-[11px] tabular text-muted-foreground">{t("coin.ofSupply", { percent: share < 0.0001 ? "<0.01%" : pctText(share, 2) })}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("coin.value")}</div>
          <div className="text-xl font-extrabold tabular leading-tight text-primary">{usd(valueSol, solUsd)}</div>
          <div className="text-[11px] tabular text-muted-foreground">{sol(valueSol)}</div>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
        <StatRow label={t("coin.costBasis")} value={usd(h.costBasisSol, solUsd)} />
        <StatRow
          label={t("coin.unrealized")}
          value={`${signedUsd(unrealizedSol, solUsd)} (${signedPct(pnlPct)})`}
          valueClass={unrealizedSol >= 0 ? "text-up" : "text-down"}
        />
        {h.realizedPnlSol !== 0 && (
          <StatRow label={t("coin.realized")} value={signedUsd(h.realizedPnlSol, solUsd)} valueClass={h.realizedPnlSol >= 0 ? "text-up" : "text-down"} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Creator "claim fees" card
// ---------------------------------------------------------------------------

function CreatorClaimCard({ coin }: { coin: CoinDetail }) {
  const t = useT();
  const solUsd = useSolUsd();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { connected, signAndSend } = useWalletTx();
  const [claiming, setClaiming] = useState(false);

  const isCreator = !!user?.walletAddress && user.walletAddress === coin.creatorWallet;
  if (!isCreator || coin.creatorClaimableSol <= 0) return null;

  const claim = async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      if (!connected) throw new Error(t("coin.claimConnectWallet"));
      const res = await apiRequest("POST", `/api/coins/${coin.ca}/claim-tx`, {});
      const unsigned = (await res.json()) as UnsignedTx;
      const sent = await signAndSend(unsigned, "claim", coin.ca);
      toast({
        title: t("coin.claimSent"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="underline">
            {t("coin.viewTransaction")}
          </a>
        ),
      });
      void qc.invalidateQueries({ queryKey: [`/api/coins/${coin.ca}`] });
      void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
    } catch (err) {
      toast({ variant: "destructive", title: t("coin.claimFailed"), description: apiErrorMessage(err, t("common.error")) });
    } finally {
      setClaiming(false);
    }
  };

  return (
    <section className="rounded-3xl border border-gold/40 bg-gold/5 p-4">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-bold text-gold">
        <Coins className="h-4 w-4" />
        {t("coin.creatorFees")}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("coin.creatorFeesHint", { share: pctText(CREATOR_FEE_SHARE, 0) })}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xl font-extrabold tabular leading-tight text-gold">{usd(coin.creatorClaimableSol, solUsd)}</div>
          <div className="text-[11px] tabular text-muted-foreground">{sol(coin.creatorClaimableSol)}</div>
        </div>
        <Button onClick={() => void claim()} disabled={claiming} className="rounded-lg font-semibold">
          {claiming && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("coin.claimFees")}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Migrated coin: link out to the Meteora DAMM v2 pool instead of the trade panel
// ---------------------------------------------------------------------------

function MigratedCard({ coin }: { coin: CoinDetail }) {
  const t = useT();
  if (!coin.curve.dammPool) return null;
  return (
    <section className="rounded-3xl border border-violet/40 bg-violet/5 p-5 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-violet/15 text-violet">
        <GraduationCap className="h-6 w-6" />
      </div>
      <h2 className="mt-3 text-base font-bold">{t("coin.migratedTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("coin.migratedHint")}</p>
      <Button asChild className="mt-4 w-full rounded-lg font-semibold">
        <a href={`https://app.meteora.ag/dammv2/${coin.curve.dammPool}`} target="_blank" rel="noopener noreferrer">
          {t("coin.tradeOnMeteora")}
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </section>
  );
}

function AboutCard({ coin }: { coin: CoinDetail }) {
  const t = useT();
  type LinkKind = "website" | "twitter" | "telegram";
  const all: { key: LinkKind; label: string; icon: LucideIcon; href: string }[] = [
    { key: "website", label: t("coin.website"), icon: Globe, href: externalUrl("website", coin.website ?? "") },
    { key: "twitter", label: t("coin.twitter"), icon: ExternalLink, href: externalUrl("twitter", coin.twitter ?? "") },
    { key: "telegram", label: t("coin.telegram"), icon: Send, href: externalUrl("telegram", coin.telegram ?? "") },
  ];
  const links = all.filter((l) => !!l.href);

  if (!coin.description && links.length === 0) return null;

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-bold">{t("coin.about")}</h2>
      {coin.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{coin.description}</p>}
      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map(({ key, label, icon: Icon, href }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-semibold text-foreground/90 transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

function CoinSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <div className="surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          <Skeleton className="h-20 w-20 shrink-0 rounded-2xl sm:h-24 sm:w-24" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Skeleton className="h-[380px] w-full rounded-2xl" />
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-56 w-full rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-[420px] w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  const t = useT();
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted text-3xl leading-none">😵</div>
      <h1 className="mt-4 text-lg font-bold">{t("coin.loadError")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <div className="mt-5 flex gap-2">
        <Button variant="outline" className="rounded-lg" onClick={onRetry}>
          <RefreshCw className={cn("h-4 w-4", retrying && "animate-spin")} />
          {t("common.retry")}
        </Button>
        <Button asChild className="rounded-lg font-semibold">
          <Link href="/">{t("common.goHome")}</Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CoinPage() {
  const t = useT();
  const { ca = "" } = useParams<{ ca: string }>();
  const valid = looksLikeCa(ca);

  const coin = useQuery<CoinDetail>({
    queryKey: [`/api/coins/${ca}`],
    enabled: valid,
    staleTime: 15_000,
    retry: (failureCount, err) => !isNotFoundError(err) && failureCount < 2,
  });

  const [mode, setMode] = useState<ChartMode>(() => loadPref(CHART_MODE_KEY, new Set(["price", "mcap"]), "price"));
  const [interval, setInterval_] = useState<ChartInterval>(() => loadPref(CHART_INTERVAL_KEY, INTERVALS, "1m"));
  const [tradeOpen, setTradeOpen] = useState(false);
  const onModeChange = useCallback((m: ChartMode) => {
    setMode(m);
    savePref(CHART_MODE_KEY, m);
  }, []);
  const onIntervalChange = useCallback((i: ChartInterval) => {
    setInterval_(i);
    savePref(CHART_INTERVAL_KEY, i);
  }, []);

  const data = coin.data;
  const title = useMemo(() => (data ? `${data.name} ($${data.ticker}) · ${t("app.name")}` : t("app.name")), [data, t]);
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);

  if (!valid) {
    return <NotFound title={t("coin.notFound")} hint={t("coin.notFoundHint", { app: t("app.name") })} />;
  }
  if (coin.isError && isNotFoundError(coin.error)) {
    return <NotFound title={t("coin.notFound")} hint={t("coin.notFoundHint", { app: t("app.name") })} />;
  }

  return (
    <PageShell wide>
      {coin.isLoading || !data ? (
        coin.isError ? (
          <ErrorState message={apiErrorMessage(coin.error, t("common.error"))} onRetry={() => void coin.refetch()} retrying={coin.isFetching} />
        ) : (
          <CoinSkeleton />
        )
      ) : (
        <div className={cn("space-y-6", !data.curve.migrated && "pb-16 lg:pb-0")}>
          <CoinHeader coin={data} />

          {/*
            Grid: on lg the aside spans both rows of the left column (chart, tabs) and sticks.
            On mobile the trade panel moves into a fixed bottom bar + sheet; DOM order gives:
            chart → creator/position/stats cards → tabs.
          */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1fr)_400px]">
            <section className="min-w-0 lg:col-start-1 lg:row-start-1">
              <CandleChart
                candles={data.candles}
                trades={data.recentTrades}
                ticker={data.ticker}
                height={380}
                mode={mode}
                onModeChange={onModeChange}
                interval={interval}
                onIntervalChange={onIntervalChange}
                className="rounded-3xl border border-border bg-card"
              />
            </section>

            <aside className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-start">
              {data.curve.migrated ? (
                <MigratedCard coin={data} />
              ) : (
                <div className="hidden lg:block">
                  <TradePanel coin={data} />
                </div>
              )}
              <CreatorClaimCard coin={data} />
              <MyPositionCard coin={data} />
              <StatsCard coin={data} />
              <AboutCard coin={data} />
            </aside>

            <section className="min-w-0 lg:col-start-1 lg:row-start-2">
              <Comments coin={data} />
            </section>
          </div>
        </div>
      )}

      {/* Mobile: trading collapses into a fixed bottom bar that opens the trade panel as a sheet */}
      {data && !data.curve.migrated && (
        <>
          <div className="safe-bottom fixed inset-x-0 bottom-14 z-30 border-t border-border bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:hidden">
            <div className="mx-auto flex max-w-7xl gap-2.5">
              <Button
                type="button"
                onClick={() => setTradeOpen(true)}
                className="tap h-12 flex-1 rounded-full bg-up text-base font-bold text-white hover:bg-up/90"
              >
                {t("trade.buy")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTradeOpen(true)}
                className="tap h-12 flex-1 rounded-full border-down/50 text-base font-bold text-down hover:bg-down/10"
              >
                {t("trade.sell")}
              </Button>
            </div>
          </div>

          <Drawer open={tradeOpen} onOpenChange={setTradeOpen}>
            <DrawerContent className="max-h-[88vh] rounded-t-3xl lg:hidden">
              <DrawerTitle className="sr-only">
                {t("trade.placeBuy", { ticker: data.ticker })} / {t("trade.placeSell", { ticker: data.ticker })}
              </DrawerTitle>
              <div className="safe-bottom overflow-y-auto px-4 pb-4">
                <TradePanel coin={data} className="border-0 bg-transparent p-0 shadow-none" />
              </div>
            </DrawerContent>
          </Drawer>
        </>
      )}
    </PageShell>
  );
}
