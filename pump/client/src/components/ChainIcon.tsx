import type { Chain } from "@shared/schema";
import { CHAIN_LABELS } from "@shared/schema";
import { TokenImage } from "@/components/TokenImage";
import { cn } from "@/lib/utils";

/**
 * The chain a token lives on, as its own mark.
 *
 * Hand-drawn approximations of these logos read as "wrong logo" rather than as
 * an icon, so the real artwork is fetched from DefiLlama's chain icon service
 * through our cached image proxy (server/imgproxy.ts). A chain it does not carry
 * falls back to the two-letter tile every icon in the app falls back to.
 */

const ICON_SLUGS: Record<Chain, string | null> = {
  solana: "solana",
  ethereum: "ethereum",
  base: "base",
  bsc: "bsc",
  monad: "monad",
  hyperliquid: "hyperliquid",
  // Not carried yet; the initials tile stands in until it is.
  robinhood: null,
};

export function chainLogoUrl(chain: Chain): string | null {
  const slug = ICON_SLUGS[chain];
  return slug ? `https://icons.llamao.fi/icons/chains/rsz_${slug}?w=48&h=48` : null;
}

export function ChainIcon({ chain, size = 20, className }: { chain: Chain; size?: number; className?: string }) {
  return (
    <TokenImage
      src={chainLogoUrl(chain)}
      name={CHAIN_LABELS[chain]}
      size={size}
      alt={CHAIN_LABELS[chain]}
      className={cn("bg-transparent", className)}
    />
  );
}

/** The little badge that sits beside a ticker in a list. */
export function ChainBadge({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0", className)} title={CHAIN_LABELS[chain]}>
      <ChainIcon chain={chain} size={16} />
    </span>
  );
}

export default ChainIcon;
