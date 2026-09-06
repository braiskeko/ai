import { formatDistanceToNowStrict, format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import type { AppConfig } from "@shared/schema";
import { SOLANA_ADDRESS_RE } from "@shared/schema";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export const pct = (p: number, digits = 0) => `${(p * 100).toFixed(digits)}%`;

/** SOL/USD used while /api/config hasn't loaded yet (mirrors server SOL_USD_FALLBACK default). */
export const SOL_USD_FALLBACK = 150;

/** Live SOL/USD rate from `GET /api/config` (refreshed by the server every 60s). */
export function useSolUsd(): number {
  const { data } = useQuery<AppConfig>({ queryKey: ["/api/config"], staleTime: Infinity, gcTime: Infinity });
  return data?.solUsd ?? SOL_USD_FALLBACK;
}

/** Solana address shape (mint / wallet / pool) — base58, 32-44 chars. */
export const looksLikeCa = (s: string): boolean => SOLANA_ADDRESS_RE.test(s);

const fmtDollar = (n: number, opts: { compact?: boolean; digits?: number } = {}) => {
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

/** Converts a SOL amount to USD (using the given SOL/USD rate) and formats it as currency. */
export const usd = (sol: number, solUsd: number): string => fmtDollar((sol || 0) * (solUsd || 0));

/** Signed USD amount from a SOL figure: 0.5 → "+$75.00", -0.5 → "-$75.00". */
export const signedUsd = (sol: number, solUsd: number): string =>
  `${sol >= 0 ? "+" : "-"}${usd(Math.abs(sol), solUsd)}`;

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

const trimZeros = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

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

/** Compact SOL amount: 3700 → "3.7K SOL", 12.5 → "12.5 SOL". */
export const compactSol = (n: number): string => {
  if (!Number.isFinite(n)) return "0 SOL";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${trimZeros((abs / 1e6).toFixed(2))}M SOL`;
  if (abs >= 1e3) return `${sign}${trimZeros((abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1))}K SOL`;
  return `${sign}${sol(abs)}`;
};

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
 * Price per token in USD. Tiny prices use the subscript-zero notation popular on DEX
 * screeners: 0.0000372 → "$0.0₄372". Larger prices fall back to plain dollars.
 */
export const priceUsd = (p: number): string => {
  if (!Number.isFinite(p) || p <= 0) return "$0.00";
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  const str = p.toFixed(20);
  const decimals = str.slice(2);
  const zeros = decimals.match(/^0*/)?.[0].length ?? 0;
  const significant = decimals.slice(zeros, zeros + 3).replace(/0+$/, "") || "0";
  if (zeros < 3) return `$0.${"0".repeat(zeros)}${significant}`;
  return `$0.0${toSubscript(zeros)}${significant}`;
};

/**
 * Price per token in SOL, same subscript notation as `priceUsd` but suffixed "SOL"
 * instead of "$": 0.0000372 → "0.0₄372 SOL".
 */
export const priceSol = (p: number): string => {
  if (!Number.isFinite(p) || p <= 0) return "0 SOL";
  if (p >= 1) return `${p.toFixed(4)} SOL`;
  if (p >= 0.01) return `${p.toFixed(6)} SOL`;
  const str = p.toFixed(20);
  const decimals = str.slice(2);
  const zeros = decimals.match(/^0*/)?.[0].length ?? 0;
  const significant = decimals.slice(zeros, zeros + 3).replace(/0+$/, "") || "0";
  if (zeros < 3) return `0.${"0".repeat(zeros)}${significant} SOL`;
  return `0.0${toSubscript(zeros)}${significant} SOL`;
};

/** Plain SOL amount: 0.0421 → "0.0421 SOL", 1 → "1 SOL", 1234.5 → "1,234.5 SOL". */
export const sol = (n: number, maxDigits = 4): string => {
  if (!Number.isFinite(n)) return "0 SOL";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs === 0) return "0 SOL";
  if (abs < 1) {
    // keep enough precision that tiny SOL amounts don't collapse to "0 SOL"
    const digits = Math.max(maxDigits, Math.min(9, -Math.floor(Math.log10(abs)) + 2));
    return `${sign}${trimZeros(abs.toFixed(digits))} SOL`;
  }
  return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: maxDigits }).format(abs)} SOL`;
};

/** Signed SOL amount: 0.5 → "+0.5 SOL", -0.5 → "-0.5 SOL". */
export const signedSol = (n: number): string => `${n >= 0 ? "+" : "-"}${sol(Math.abs(n))}`;

/** "Ab12Cd…noxia" — first 4 chars + last 5 (the vanity "noxia" suffix, when present). */
export const shortCa = (ca: string, head = 4, tail = 5): string =>
  ca.length <= head + tail + 1 ? ca : `${ca.slice(0, head)}…${ca.slice(-tail)}`;

/** "Ab12…9f3c" style short wallet/account address. */
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
