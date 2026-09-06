import { useState, type ReactNode } from "react";
import { Delete, Loader2, Plus, X } from "lucide-react";
import { LAUNCH_MCAP_USD, LAUNCH_MIN_BUY_USD } from "@shared/schema";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The last step of a launch: buy your own coin.
 *
 * Filling the coin in is free — the image, the name, the metadata all live on
 * our side until this screen. Pressing the button here is the transaction that
 * creates the coin on-chain, and the tokens it buys are the creator's own share
 * of the supply, which is why the amount is shown as a percentage too.
 */

const MAX_DIGITS = 12;
const PCT_CHIPS = [0.1, 0.25, 0.5] as const;

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
 * Roughly what slice of the supply a first buy of `usd` takes.
 *
 * The pool does not exist yet, so there is nothing to quote against: this is the
 * share you get by adding `usd` to a coin that starts life at the launch market
 * cap, which is what the curve pays out at the very start.
 */
export function supplyShare(usd: number, launchMcapUsd = LAUNCH_MCAP_USD): number {
  if (!(usd > 0)) return 0;
  return usd / (launchMcapUsd + usd);
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

export function LaunchKeypad({
  ticker,
  image,
  availableUsd,
  launchMcapUsd,
  busy,
  busyLabel,
  onCancel,
  onConfirm,
  onDeposit,
}: {
  ticker: string;
  image: string;
  /** spendable balance, in USD */
  availableUsd: number;
  launchMcapUsd?: number;
  busy: boolean;
  busyLabel: string;
  onCancel: () => void;
  onConfirm: (amountUsd: number) => void;
  onDeposit: () => void;
}) {
  const t = useT();
  const [raw, setRaw] = useState(String(LAUNCH_MIN_BUY_USD));
  const amountUsd = Number(raw) || 0;

  const share = supplyShare(amountUsd, launchMcapUsd);
  const belowMin = amountUsd < LAUNCH_MIN_BUY_USD;
  const exceedsBalance = amountUsd > availableUsd + 1e-9;

  const label = (): ReactNode => {
    if (busy) return <Loader2 className="h-5 w-5 animate-spin" />;
    if (exceedsBalance) return t("home.deposit");
    if (belowMin) return t("launch.minimum", { amount: `$${LAUNCH_MIN_BUY_USD}` });
    return t("launch.confirm", { ticker: `$${ticker}`, amount: `$${raw}` });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={t("common.cancel")}
          className="tap grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <X className="h-5 w-5" />
        </button>
        {image ? (
          <img src={image} alt="" className="h-10 w-10 shrink-0 rounded-full bg-muted object-cover" />
        ) : (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-xs font-black text-muted-foreground">
            {ticker.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-extrabold uppercase leading-tight">{ticker}</div>
          <div className="truncate text-xs text-muted-foreground">{t("launch.firstBuy")}</div>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className={cn("text-6xl font-extrabold tabular", amountUsd > 0 ? "text-foreground" : "text-muted-foreground/40")}>
          ${raw || "0"}
        </div>
        <p className="mt-3 text-center text-sm text-muted-foreground">
          {amountUsd > 0
            ? t("launch.supplyShare", { pct: share < 0.0001 ? "<0.01%" : `${(share * 100).toFixed(2)}%` })
            : t("launch.freeUntilNow")}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2 px-4">
        {PCT_CHIPS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={availableUsd <= 0 || busy}
            onClick={() => setRaw((availableUsd * p).toFixed(2).replace(/\.?0+$/, ""))}
            className="tap h-10 rounded-xl bg-muted/60 text-sm font-bold text-foreground disabled:opacity-40"
          >
            {Math.round(p * 100)}%
          </button>
        ))}
        <button
          type="button"
          disabled={availableUsd <= 0 || busy}
          onClick={() => setRaw(availableUsd.toFixed(2).replace(/\.?0+$/, ""))}
          className="tap h-10 rounded-xl bg-muted/60 text-sm font-bold text-foreground disabled:opacity-40"
        >
          {t("trade.max")}
        </button>
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
        <button type="button" onClick={onDeposit} className="tap inline-flex items-center gap-1.5">
          <span className="tabular">{t("tradeSheet.available", { amount: `$${availableUsd.toFixed(2)}` })}</span>
          <Plus className="h-3.5 w-3.5" />
        </button>
        {busy && <span className="tabular">{busyLabel}</span>}
      </div>

      <div className="safe-bottom px-4 pb-4">
        <button
          type="button"
          onClick={() => (exceedsBalance ? onDeposit() : onConfirm(amountUsd))}
          disabled={busy || (belowMin && !exceedsBalance)}
          className={cn(
            "tap h-14 w-full rounded-2xl text-lg font-extrabold text-white transition-colors disabled:cursor-not-allowed",
            belowMin && !exceedsBalance ? "bg-muted text-muted-foreground" : "bg-up hover:bg-up/90",
          )}
        >
          {label()}
        </button>
      </div>
    </div>
  );
}

export default LaunchKeypad;
