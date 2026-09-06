import type { Chain } from "@shared/schema";
import { CHAIN_LABELS } from "@shared/schema";
import { cn } from "@/lib/utils";

/**
 * The chain a token lives on, as its mark rather than its name — a row has room
 * for a glyph, not for "Hyperliquid".
 *
 * Drawn inline and in `currentColor` on purpose: an <img> per row would be
 * another request that can fail, and these have to be legible at 12px in both
 * themes.
 */
const PATHS: Record<Chain, JSX.Element> = {
  // Solana's three slanted bars.
  solana: (
    <g>
      <path d="M5 17.2c.12-.13.29-.2.46-.2H20c.28 0 .42.34.22.54l-2.7 2.7a.63.63 0 0 1-.45.19H2.6c-.28 0-.42-.34-.22-.54l2.62-2.69Z" />
      <path d="M5 3.57c.13-.13.3-.2.46-.2H20c.28 0 .42.34.22.54l-2.7 2.7a.63.63 0 0 1-.45.19H2.6c-.28 0-.42-.34-.22-.54L5 3.57Z" />
      <path d="M17.52 10.34a.63.63 0 0 0-.45-.19H2.6c-.28 0-.42.34-.22.54l2.62 2.7c.12.12.29.19.46.19H20c.28 0 .42-.34.22-.54l-2.7-2.7Z" />
    </g>
  ),
  // Ethereum's octahedron.
  ethereum: (
    <g>
      <path d="M12 2 5.6 12.1 12 15.9l6.4-3.8L12 2Z" />
      <path d="M5.6 13.5 12 22l6.4-8.5-6.4 3.8-6.4-3.8Z" opacity={0.75} />
    </g>
  ),
  // Base's ring.
  base: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.4a6.6 6.6 0 0 1 6.5 5.5H8.6v2.2h9.9A6.6 6.6 0 1 1 12 5.4Z" />,
  // BNB's rotated square with satellites.
  bsc: (
    <g>
      <path d="m12 2 3.1 3.1L12 8.2 8.9 5.1 12 2Zm-6.9 6.9L8.2 12l-3.1 3.1L2 12l3.1-3.1Zm13.8 0L22 12l-3.1 3.1L15.8 12l3.1-3.1ZM12 15.8l3.1 3.1L12 22l-3.1-3.1 3.1-3.1Z" />
      <path d="M12 8.9 15.1 12 12 15.1 8.9 12 12 8.9Z" opacity={0.75} />
    </g>
  ),
  // Monad's rounded lozenge.
  monad: <path d="M12 2c4 0 8 5 8 10s-4 10-8 10-8-5-8-10S8 2 12 2Zm0 3.6c-1.9 0-4 3.3-4 6.4s2.1 6.4 4 6.4 4-3.3 4-6.4-2.1-6.4-4-6.4Z" />,
  // Hyperliquid's pinched wave.
  hyperliquid: (
    <path d="M3 12c0-3 1.4-5 3.4-5 2.6 0 3.4 4 5.6 4s2.2-4 4.6-4c2 0 3.4 2 3.4 5s-1.4 5-3.4 5c-2.4 0-2.4-4-4.6-4s-3 4-5.6 4C4.4 17 3 15 3 12Z" />
  ),
  // Robinhood's feather.
  robinhood: <path d="M18.5 2.3c.6-.3 1.3.3 1.1.9-2 6.8-5.6 12-10.8 15.6l-.5.4-1.4 2.4a1 1 0 0 1-1.7-1l1.4-2.4C7.9 11.9 12 6 18.5 2.3Z" />,
};

export function ChainIcon({ chain, size = 14, className }: { chain: Chain; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label={CHAIN_LABELS[chain]}
      className={cn("shrink-0", className)}
    >
      <title>{CHAIN_LABELS[chain]}</title>
      {PATHS[chain]}
    </svg>
  );
}

/** The little badge that sits beside a ticker in a list. */
export function ChainBadge({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <span
      className={cn(
        "inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground",
        className,
      )}
      title={CHAIN_LABELS[chain]}
    >
      <ChainIcon chain={chain} size={12} />
    </span>
  );
}

export default ChainIcon;
