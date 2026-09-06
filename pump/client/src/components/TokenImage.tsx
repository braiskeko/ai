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

/** The URL to try first: as published, unless it is a scheme no browser can load. */
export function iconSrc(url: string | null | undefined): string | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  if (v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("/")) return v;
  if (/^https?:/i.test(v)) return v;
  // ipfs:// and ar:// mean nothing to a browser — those start at the proxy.
  if (/^(ipfs:|ar:)/i.test(v)) return proxiedSrc(v);
  return null;
}

/** Our cached server-side fetch of the same image (server/imgproxy.ts). */
export function proxiedSrc(url: string): string {
  return `/api/img?u=${encodeURIComponent(url)}`;
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
  // Three attempts, in order: the published URL, the same image through our proxy
  // (which defeats hot-link blocking and dead IPFS gateways), then initials.
  const [stage, setStage] = useState<"direct" | "proxy" | "failed">("direct");
  useEffect(() => setStage("direct"), [resolved]);

  const proxyable = !!src && /^(https?:|ipfs:|ar:)/i.test(src.trim());
  const failed = stage === "failed";
  const url = stage === "proxy" && src ? proxiedSrc(src.trim()) : resolved;

  const shape = cn("shrink-0 rounded-full bg-muted object-cover", className);
  if (!url || failed) {
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
      key={stage}
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setStage(stage === "direct" && proxyable ? "proxy" : "failed")}
      className={shape}
      style={{ width: size, height: size }}
    />
  );
}

export default TokenImage;
