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
