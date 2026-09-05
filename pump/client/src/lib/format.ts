import { formatDistanceToNowStrict, format } from "date-fns";

export const pct = (p: number, digits = 0) => `${(p * 100).toFixed(digits)}%`;

/** Price shown in cents, Polymarket style: 0.41 -> "41¢" */
export const cents = (p: number) => {
  const c = p * 100;
  if (c < 1) return "<1¢";
  if (c > 99) return ">99¢";
  return `${Math.round(c)}¢`;
};

export const usd = (n: number, opts: { compact?: boolean; digits?: number } = {}) => {
  const { compact = false, digits } = opts;
  if (compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits ?? 2,
    maximumFractionDigits: digits ?? 2,
  }).format(n);
};

export const signedUsd = (n: number) => (n >= 0 ? `+${usd(n)}` : `-${usd(Math.abs(n))}`);

export const shares = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

export const timeAgo = (iso: string | Date) => {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return formatDistanceToNowStrict(d, { addSuffix: true })
    .replace(" seconds", "s")
    .replace(" second", "s")
    .replace(" minutes", "m")
    .replace(" minute", "m")
    .replace(" hours", "h")
    .replace(" hour", "h")
    .replace(" days", "d")
    .replace(" day", "d")
    .replace(" months", "mo")
    .replace(" month", "mo")
    .replace(" years", "y")
    .replace(" year", "y");
};

export const dateShort = (iso: string | Date) => format(new Date(iso), "MMM d, yyyy");

// ---------------------------------------------------------------------------
// Memecoin-specific formatters
// ---------------------------------------------------------------------------

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const toSubscript = (n: number) =>
  String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");

/** Compact dollar amount: 3700 → "$3.7K", 1_234_000 → "$1.2M", 12.5 → "$12.50". */
export const compactUsd = (n: number): string => {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${trimZeros((abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1))}B`;
  if (abs >= 1e6) return `${sign}$${trimZeros((abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`;
  if (abs >= 1e3) return `${sign}$${trimZeros((abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1))}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs === 0) return "$0";
  return `${sign}${priceUsd(abs)}`;
};

const trimZeros = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/** Token amounts: 12_400_000 → "12.4M", 950 → "950", 0.5 → "0.5". */
export const tokens = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${trimZeros((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}${trimZeros((abs / 1e6).toFixed(abs >= 1e8 ? 0 : 1))}M`;
  if (abs >= 1e3) return `${sign}${trimZeros((abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}K`;
  if (abs >= 1) return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(abs)}`;
  return `${sign}${trimZeros(abs.toFixed(4))}`;
};

/**
 * Price per token. Tiny prices use the subscript-zero notation popular on DEX
 * screeners: 0.0000372 → "$0.0₄372". Larger prices fall back to plain dollars.
 */
export const priceUsd = (p: number): string => {
  if (!Number.isFinite(p) || p <= 0) return "$0.00";
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  // count leading zeros after the decimal point
  const str = p.toFixed(20);
  const decimals = str.slice(2);
  const zeros = decimals.match(/^0*/)?.[0].length ?? 0;
  const significant = decimals.slice(zeros, zeros + 3).replace(/0+$/, "") || "0";
  if (zeros < 3) return `$0.${"0".repeat(zeros)}${significant}`;
  return `$0.0${toSubscript(zeros)}${significant}`;
};

/** "Ab12Cd…noxia" — first 4 chars + last 5 (the "noxia" suffix). */
export const shortCa = (ca: string, head = 4, tail = 5): string =>
  ca.length <= head + tail + 1 ? ca : `${ca.slice(0, head)}…${ca.slice(-tail)}`;

/** "0xAb12…9f3c" style EVM address. */
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Signed percentage change: 0.123 → "+12.3%", -0.05 → "-5.0%". */
export const signedPct = (p: number, digits = 1) => `${p >= 0 ? "+" : ""}${(p * 100).toFixed(digits)}%`;

/** Compact age without the "ago" suffix: 45s, 3m, 2h, 5d. Pair with t("coin.ago", { time }). */
export const age = (iso: string | Date): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
};

export const endsIn = (iso: string | Date) => {
  const d = new Date(iso);
  if (d.getTime() < Date.now()) return "Ended";
  return `Ends ${formatDistanceToNowStrict(d, { addSuffix: false })
    .replace(" days", "d")
    .replace(" day", "d")
    .replace(" hours", "h")
    .replace(" hour", "h")
    .replace(" months", "mo")
    .replace(" month", "mo")} from now`;
};
