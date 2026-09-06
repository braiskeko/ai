import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A token icon that actually shows up.
 *
 * Token metadata points at IPFS gateways, `ipfs://` URIs and hosts that block
 * hot-linking, so a plain <img> leaves half a list blank. Remote URLs are routed
 * through our own cached proxy (`/api/img`, see server/imgproxy.ts); what still
 * fails falls back to an initials tile rather than a broken-image glyph.
 */

/** Rewrites a remote icon URL to our proxy; local uploads and data URLs pass through. */
export function iconSrc(url: string | null | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  if (v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("/")) return v;
  if (/^(https?:|ipfs:|ar:)/i.test(v)) return `/api/img?u=${encodeURIComponent(v)}`;
  return null;
}

export interface TokenImageProps {
  src: string | null | undefined;
  /** Ticker or name — its first two characters draw the fallback tile. */
  name: string;
  size: number;
  /** Extra classes; pass the radius you want (defaults to a circle). */
  className?: string;
  alt?: string;
}

export function TokenImage({ src, name, size, className, alt = "" }: TokenImageProps) {
  const resolved = iconSrc(src);
  const [failed, setFailed] = useState(false);
  // A row re-used for a different token must try the new icon.
  useEffect(() => setFailed(false), [resolved]);

  const shape = cn("shrink-0 rounded-full bg-muted object-cover", className);
  if (!resolved || failed) {
    return (
      <span
        className={cn(shape, "grid place-items-center font-black uppercase text-muted-foreground")}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size / 3)) }}
        aria-hidden
      >
        {name.slice(0, 2)}
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={shape}
      style={{ width: size, height: size }}
    />
  );
}

export default TokenImage;
