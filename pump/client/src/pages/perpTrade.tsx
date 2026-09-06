import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronsUpDown, Delete, Info, Plus } from "lucide-react";
import type { PerpDetail, WalletView } from "@shared/schema";
import { perpLogo } from "@/components/PerpsList";
import { TokenImage } from "@/components/TokenImage";
import { useDepositSheet } from "@/components/DepositSheet";
import { SwipeConfirm } from "@/components/SwipeConfirm";
import { Skeleton } from "@/components/ui/skeleton";
import NotFound from "@/pages/not-found";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { getQueryFn } from "@/lib/queryClient";
import { compactUsd, priceUsd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Long or short a perpetual market: `/perp/<symbol>/long`.
 *
 * The amount is the margin you put up, in dollars; leverage is a ruler you drag
 * sideways, capped at whatever that market allows on Hyperliquid. Filling the
 * order is not wired to Hyperliquid yet — everything else here is real, so the
 * screen is the one the trade will use when it is.
 */

const MAX_DIGITS = 12;
const AMOUNT_CHIPS = [10, 50, 100, 300] as const;
const FEE_RESERVE_SOL = 0.01;
/** Width of one leverage step in the ruler, in px. */
const STEP_W = 88;

function pressDigit(raw: string, digit: string): string {
  if (digit === ".") {
    if (raw.includes(".")) return raw;
    return raw ? `${raw}.` : "0.";
  }
  if (raw === "0") return digit;
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  if (decimals >= 2) return raw;
  if (raw.replace(".", "").length >= MAX_DIGITS) return raw;
  return raw + digit;
}

/**
 * Where the position gets closed out, ignoring fees and funding: the price at
 * which the margin is gone, which is one leverage-step away from entry.
 */
export function liquidationPrice(entry: number, leverage: number, side: "long" | "short"): number {
  if (!(entry > 0) || !(leverage >= 1)) return 0;
  const move = entry / leverage;
  return side === "long" ? Math.max(0, entry - move) : entry + move;
}

/** The leverage ruler: drag sideways, the middle value is the one you get. */
function LeverageRuler({ max, value, onChange }: { max: number; value: number; onChange: (v: number) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const steps = useMemo(() => Array.from({ length: Math.max(1, max) }, (_, i) => i + 1), [max]);
  const settling = useRef<number | null>(null);

  // Keep the selected step under the centre line when it changes from outside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = (value - 1) * STEP_W;
    if (Math.abs(el.scrollLeft - target) > 2) el.scrollTo({ left: target, behavior: "smooth" });
    // Only when the value itself changes: scrolling reports its own value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (settling.current !== null) cancelAnimationFrame(settling.current);
    settling.current = requestAnimationFrame(() => {
      const next = Math.min(max, Math.max(1, Math.round(el.scrollLeft / STEP_W) + 1));
      if (next !== value) onChange(next);
    });
  };

  return (
    <div className="select-none">
      <div className="relative">
        {/* The bracket that marks the chosen step */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-[86px] -translate-x-1/2 -translate-y-1/2 rounded-lg border-y-2 border-primary/70"
        />
        <div
          ref={ref}
          onScroll={onScroll}
          role="slider"
          aria-label={t("perps.leverage")}
          aria-valuemin={1}
          aria-valuemax={max}
          aria-valuenow={value}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") onChange(Math.min(max, value + 1));
            if (e.key === "ArrowLeft") onChange(Math.max(1, value - 1));
          }}
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
          style={{ scrollPaddingLeft: "50%", paddingLeft: `calc(50% - ${STEP_W / 2}px)`, paddingRight: `calc(50% - ${STEP_W / 2}px)` }}
        >
          {steps.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              style={{ width: STEP_W }}
              className={cn(
                "h-14 shrink-0 snap-center text-center text-2xl font-extrabold tabular transition-colors",
                s === value ? "text-primary" : "text-muted-foreground/50",
              )}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 text-center text-sm text-muted-foreground">{t("perps.leverage")}</div>
    </div>
  );
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

export default function PerpTradePage() {
  const t = useT();
  const { toast } = useToast();
  const solUsd = useSolUsd();
  const [, navigate] = useLocation();
  const { user, openLogin } = useAuth();
  const deposit = useDepositSheet();
  const { symbol = "" } = useParams<{ symbol: string }>();
  const [isLong] = useRoute("/perp/:symbol/long");
  const side: "long" | "short" = isLong ? "long" : "short";

  const market = useQuery<PerpDetail>({
    queryKey: [`/api/perps/${encodeURIComponent(symbol)}`],
    enabled: symbol.length > 0,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: (count, err) => !(err instanceof Error && /^404:/.test(err.message)) && count < 2,
  });
  const data = market.data;

  const wallet = useQuery<WalletView | null>({
    queryKey: ["/api/wallet"],
    queryFn: getQueryFn<WalletView | null>({ on401: "returnNull" }),
    enabled: !!user?.walletAddress,
    staleTime: 15_000,
  });
  const availableUsd = Math.max(0, (wallet.data?.balanceSol ?? 0) - FEE_RESERVE_SOL) * solUsd;

  const [raw, setRaw] = useState("");
  const [leverage, setLeverage] = useState(5);
  const amountUsd = Number(raw) || 0;

  const maxLeverage = data?.maxLeverage ?? 20;
  useEffect(() => {
    setLeverage((l) => Math.min(Math.max(1, l), maxLeverage));
  }, [maxLeverage]);

  useEffect(() => {
    if (!data) return;
    const prev = document.title;
    document.title = `${side === "long" ? t("perps.long") : t("perps.short")} ${data.symbol} · ${t("app.name")}`;
    return () => {
      document.title = prev;
    };
  }, [data, side, t]);

  if (market.isError && market.error instanceof Error && /^404:/.test(market.error.message)) {
    return <NotFound title={t("perps.notFound")} hint={t("perps.notFoundHint")} />;
  }

  const liq = data ? liquidationPrice(data.priceUsd, leverage, side) : 0;
  const exceedsBalance = amountUsd > availableUsd + 1e-9;

  const submit = () => {
    if (!user) {
      openLogin();
      return;
    }
    if (exceedsBalance) {
      deposit.open();
      return;
    }
    // Order routing to Hyperliquid is not live yet; the screen is.
    toast({ title: t("perps.tradingSoon") });
  };

  /** The order is ready to send: everything else is a plain button. */
  const ready = !!user && !exceedsBalance && amountUsd > 0;

  const ctaLabel = (): string => {
    if (!user) return t("trade.loginToTrade");
    if (exceedsBalance) return t("home.deposit");
    if (amountUsd <= 0) return t("tradeSheet.enterAmount");
    const label = side === "long" ? t("perps.long") : t("perps.short");
    return `${label} ${data?.symbol ?? ""} · $${raw}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => navigate(`/perp/${encodeURIComponent(symbol)}`)}
          aria-label={t("common.back")}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {!data ? (
          <Skeleton className="h-10 flex-1 rounded-xl" />
        ) : (
          <>
            <TokenImage src={perpLogo(data.symbol)} name={data.symbol} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-extrabold uppercase leading-tight">{data.symbol}</div>
              <div className="truncate text-xs text-muted-foreground">
                {compactUsd(data.openInterestUsd)} {t("perps.oiShort")}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular leading-tight">{priceUsd(data.priceUsd)}</div>
              <div className="inline-flex items-center gap-0.5 text-[11px] font-bold text-primary">
                <ChevronsUpDown className="h-3 w-3" />
                {t("perps.market")}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-center gap-6 px-4">
        <div className={cn("text-center text-6xl font-extrabold tabular", amountUsd > 0 ? "text-foreground" : "text-muted-foreground/40")}>
          ${raw || "0"}
        </div>

        <LeverageRuler max={maxLeverage} value={leverage} onChange={setLeverage} />

        <div className="flex items-start justify-between gap-4 text-sm">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1 text-muted-foreground">
              {t("perps.liquidationPrice")}
              <Info className="h-3.5 w-3.5" />
            </div>
            <div className={cn("font-semibold tabular", amountUsd > 0 ? "text-foreground" : "text-muted-foreground/60")}>
              {amountUsd > 0 && liq > 0 ? priceUsd(liq) : t("tradeSheet.enterAmount")}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-muted-foreground">{t("perps.slTp")}</div>
            <button type="button" onClick={() => toast({ title: t("perps.tradingSoon") })} className="tap font-semibold text-muted-foreground">
              {t("perps.addSlTp")}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 px-4">
        {AMOUNT_CHIPS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setRaw(String(v))}
            className="tap h-11 rounded-2xl bg-muted/60 text-base font-bold text-foreground"
          >
            ${v}
          </button>
        ))}
      </div>

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

      <div className="flex items-center justify-between px-4 pb-2 text-sm text-muted-foreground">
        <button type="button" onClick={deposit.open} className="tap inline-flex items-center gap-1.5">
          <span className="tabular">{t("tradeSheet.available", { amount: `$${availableUsd.toFixed(2)}` })}</span>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* A real order is a swipe; signing in or adding cash stays a tap. */}
      <div className="safe-bottom px-4 pb-4">
        {ready ? (
          <SwipeConfirm label={ctaLabel()} tone={side === "long" ? "up" : "down"} onConfirm={submit} />
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!!user && !exceedsBalance && amountUsd <= 0}
            className={cn(
              "tap h-14 w-full rounded-2xl text-lg font-extrabold text-white transition-colors disabled:cursor-not-allowed",
              amountUsd <= 0 && !exceedsBalance
                ? "bg-muted text-muted-foreground"
                : side === "long"
                  ? "bg-up hover:bg-up/90"
                  : "bg-down hover:bg-down/90",
            )}
          >
            {ctaLabel()}
          </button>
        )}
      </div>
      {deposit.sheet}
    </div>
  );
}
