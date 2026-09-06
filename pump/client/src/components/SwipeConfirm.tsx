import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Drag right to confirm — the last gesture before money moves.
 *
 * A buy, a sell, a long, a short and a launch all end here: the handle sits on
 * the left, you push it across, and the order only goes through once it reaches
 * the end. A slip of the thumb costs nothing, which is the point. Keyboard users
 * get the same thing from the handle: Enter, Space or → confirms.
 */

/** How far along the track counts as "all the way". */
const COMMIT = 0.88;

export function SwipeConfirm({
  label,
  onConfirm,
  disabled = false,
  busy = false,
  tone = "up",
  className,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Colour of the track: a buy is green, a sell or a short is red. */
  tone?: "up" | "down";
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const start = useRef(0);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);

  // A new amount, or an order that came back, puts the handle home again.
  useEffect(() => {
    if (!busy) setX(0);
  }, [busy, label]);

  const travel = (): number => {
    const track = trackRef.current;
    const handle = handleRef.current;
    if (!track || !handle) return 0;
    return Math.max(0, track.clientWidth - handle.offsetWidth - 8);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = e.clientX - x;
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    setX(Math.min(travel(), Math.max(0, e.clientX - start.current)));
  };

  const release = () => {
    if (!dragging) return;
    setDragging(false);
    const max = travel();
    if (max > 0 && x >= max * COMMIT) {
      setX(max);
      onConfirm();
    } else {
      setX(0);
    }
  };

  const progress = travel() > 0 ? x / travel() : 0;

  return (
    <div
      ref={trackRef}
      className={cn(
        "relative h-14 w-full select-none overflow-hidden rounded-2xl",
        disabled || busy ? "bg-muted" : tone === "up" ? "bg-up" : "bg-down",
        className,
      )}
    >
      {/* The label fades as the handle covers it. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 grid place-items-center px-16 text-center text-lg font-extrabold",
          disabled || busy ? "text-muted-foreground" : "text-white",
        )}
        style={{ opacity: 1 - progress * 0.9 }}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : label}
      </div>

      <button
        ref={handleRef}
        type="button"
        disabled={disabled || busy}
        aria-label={label}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(e) => {
          if (disabled || busy) return;
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
            e.preventDefault();
            setX(travel());
            onConfirm();
          }
        }}
        style={{ transform: `translateX(${x}px)`, transition: dragging ? "none" : "transform 180ms ease-out" }}
        className={cn(
          "absolute left-1 top-1 grid h-12 w-16 touch-none place-items-center rounded-xl text-white/90",
          disabled || busy ? "bg-foreground/10 text-muted-foreground" : "bg-black/25 active:bg-black/35",
        )}
      >
        <ChevronsRight className="h-5 w-5" />
      </button>
    </div>
  );
}

export default SwipeConfirm;
