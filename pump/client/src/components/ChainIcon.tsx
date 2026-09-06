import { useEffect, useState } from "react";
import type { Chain } from "@shared/schema";
import { CHAIN_LABELS } from "@shared/schema";
import { cn } from "@/lib/utils";

/**
 * The mark of a chain.
 *
 * Real artwork first: each chain lists the places that host its logo and they are
 * tried in order, through our cached image proxy when a direct load fails. What
 * nobody hosts — or what fails on a bad connection — falls back to a drawn mark
 * rather than a tile of letters, because a letter tile in a list of logos reads
 * as a broken image.
 */

const LLAMA = (slug: string) => `https://icons.llamao.fi/icons/chains/rsz_${slug}?w=48&h=48`;
const TRUST = (slug: string) => `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/info/logo.png`;

const SOURCES: Record<Chain, string[]> = {
  solana: [LLAMA("solana"), TRUST("solana")],
  ethereum: [LLAMA("ethereum"), TRUST("ethereum")],
  base: [LLAMA("base"), TRUST("base")],
  bsc: [LLAMA("bsc"), TRUST("smartchain")],
  monad: [LLAMA("monad")],
  hyperliquid: [LLAMA("hyperliquid"), LLAMA("hyperevm")],
  robinhood: [LLAMA("robinhood")],
};

/** Drawn marks, used only when no hosted logo loads. */
const GLYPHS: Record<Chain, JSX.Element> = {
  solana: (
    <g>
      <path d="M5 17.2c.12-.13.29-.2.46-.2H20c.28 0 .42.34.22.54l-2.7 2.7a.63.63 0 0 1-.45.19H2.6c-.28 0-.42-.34-.22-.54l2.62-2.69Z" />
      <path d="M5 3.57c.13-.13.3-.2.46-.2H20c.28 0 .42.34.22.54l-2.7 2.7a.63.63 0 0 1-.45.19H2.6c-.28 0-.42-.34-.22-.54L5 3.57Z" />
      <path d="M17.52 10.34a.63.63 0 0 0-.45-.19H2.6c-.28 0-.42.34-.22.54l2.62 2.7c.12.12.29.19.46.19H20c.28 0 .42-.34.22-.54l-2.7-2.7Z" />
    </g>
  ),
  ethereum: (
    <g>
      <path d="M12 2 5.6 12.1 12 15.9l6.4-3.8L12 2Z" />
      <path d="M5.6 13.5 12 22l6.4-8.5-6.4 3.8-6.4-3.8Z" opacity={0.7} />
    </g>
  ),
  // Base's mark: a disc with its right edge squared off.
  base: <path d="M11.6 2a10 10 0 1 0 0 20c5.2 0 9.5-4 9.9-9H8.7V11h12.8c-.4-5-4.7-9-9.9-9Z" />,
  bsc: (
    <g>
      <path d="m12 2 3.1 3.1L12 8.2 8.9 5.1 12 2Zm-6.9 6.9L8.2 12l-3.1 3.1L2 12l3.1-3.1Zm13.8 0L22 12l-3.1 3.1L15.8 12l3.1-3.1ZM12 15.8l3.1 3.1L12 22l-3.1-3.1 3.1-3.1Z" />
      <path d="M12 8.9 15.1 12 12 15.1 8.9 12 12 8.9Z" opacity={0.7} />
    </g>
  ),
  // Monad's rounded lozenge with its hollow centre.
  monad: <path d="M12 2c4.1 0 8 5 8 10s-3.9 10-8 10-8-5-8-10 3.9-10 8-10Zm0 4c-1.8 0-3.6 3-3.6 6s1.8 6 3.6 6 3.6-3 3.6-6-1.8-6-3.6-6Z" />,
  // Hyperliquid: two rounded lobes meeting in the middle.
  hyperliquid: (
    <path d="M2.6 12c0-3.3 1.6-5.6 3.9-5.6 2.8 0 3.4 4.2 5.5 4.2s2.5-4.2 5.5-4.2c2.3 0 3.9 2.3 3.9 5.6s-1.6 5.6-3.9 5.6c-3 0-3.4-4.2-5.5-4.2s-2.7 4.2-5.5 4.2C4.2 17.6 2.6 15.3 2.6 12Z" />
  ),
  robinhood: <path d="M18.5 2.3c.6-.3 1.3.3 1.1.9-2 6.8-5.6 12-10.8 15.6l-.5.4-1.4 2.4a1 1 0 0 1-1.7-1l1.4-2.4C7.9 11.9 12 6 18.5 2.3Z" />,
};

/** Our cached server-side copy of the same image (server/imgproxy.ts). */
const proxied = (url: string) => `/api/img?u=${encodeURIComponent(url)}`;

export function ChainIcon({ chain, size = 20, className }: { chain: Chain; size?: number; className?: string }) {
  // Each hosted source is tried directly, then through the proxy; the drawn mark
  // is the last step.
  const candidates = SOURCES[chain].flatMap((url) => [url, proxied(url)]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [chain]);

  const label = CHAIN_LABELS[chain];
  if (attempt >= candidates.length) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" role="img" aria-label={label} className={cn("shrink-0", className)}>
        <title>{label}</title>
        {GLYPHS[chain]}
      </svg>
    );
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={label}
      title={label}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((n) => n + 1)}
      className={cn("shrink-0 rounded-full object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The little badge beside a ticker in a list — the drawn mark in a soft circle,
 * as it was. Only the deposit screen, where the logo is the thing being picked,
 * loads the real artwork.
 */
export function ChainBadge({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <span
      className={cn(
        "inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground",
        className,
      )}
      title={CHAIN_LABELS[chain]}
    >
      <svg viewBox="0 0 24 24" width={12} height={12} fill="currentColor" aria-hidden>
        {GLYPHS[chain]}
      </svg>
    </span>
  );
}

export default ChainIcon;
