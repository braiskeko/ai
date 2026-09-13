import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A number that shows it moved.
 *
 * Lists re-read prices every few seconds; without a cue the change is invisible
 * unless you happen to be staring at that row. So when the value changes the
 * number flashes once — green up, red down — with a tint behind it rather than a
 * colour change, which would fight the text colour of a percentage that is
 * already green or red.
 *
 * The flash is skipped on the first render and for people who ask for reduced
 * motion; the value itself always updates.
 */
export function LiveNumber({
  value,
  children,
  className,
}: {
  /** The number being watched — the rendered text can be anything derived from it. */
  value: number;
  children: React.ReactNode;
  className?: string;
}) {
  const previous = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === null || !Number.isFinite(value) || !Number.isFinite(before)) return;
    if (Math.abs(value - before) < Math.abs(before) * 1e-9) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    setFlash(value > before ? "up" : "down");
    const id = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(id);
  }, [value]);

  return (
    <span className={cn(flash === "up" && "tick-up", flash === "down" && "tick-down", className)}>{children}</span>
  );
}

export default LiveNumber;
