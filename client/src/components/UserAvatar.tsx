import { cn } from "@/lib/utils";

/** Deterministic gradient avatar from a seed string — no external images needed. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function UserAvatar({
  seed,
  name,
  className,
  size = 28,
}: {
  seed: string;
  name?: string;
  className?: string;
  size?: number;
}) {
  const h = hash(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + (h >> 8) % 80) % 360;
  const angle = (h >> 16) % 360;
  const initial = (name ?? seed).trim().charAt(0).toUpperCase();
  return (
    <div
      aria-hidden
      className={cn("shrink-0 rounded-full flex items-center justify-center font-semibold text-white/90", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: `linear-gradient(${angle}deg, hsl(${hue1} 70% 45%), hsl(${hue2} 70% 55%))`,
      }}
    >
      {initial}
    </div>
  );
}
