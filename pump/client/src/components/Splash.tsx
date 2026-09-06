import { useEffect, useState } from "react";

const HOLD_MS = 2000;
const FADE_MS = 550;

/**
 * Opening screen: the logo breathes in over a plain ground, holds for two seconds, then the
 * whole layer fades and lifts away. It sits above everything and stops receiving pointer
 * events as soon as it starts leaving, so nothing feels blocked.
 *
 * Shown once per browser session, and skipped entirely for people who ask for reduced motion.
 */
export function Splash() {
  const [phase, setPhase] = useState<"in" | "out" | "gone">(() => {
    if (typeof window === "undefined") return "gone";
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "gone";
      if (sessionStorage.getItem("nx_splash") === "1") return "gone";
      sessionStorage.setItem("nx_splash", "1");
    } catch {
      /* private mode: show it, it is harmless */
    }
    return "in";
  });

  useEffect(() => {
    if (phase !== "in") return;
    const leave = setTimeout(() => setPhase("out"), HOLD_MS);
    return () => clearTimeout(leave);
  }, [phase]);

  useEffect(() => {
    if (phase !== "out") return;
    const done = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(done);
  }, [phase]);

  if (phase === "gone") return null;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-[100] grid place-items-center bg-background"
      style={{
        pointerEvents: phase === "out" ? "none" : "auto",
        opacity: phase === "out" ? 0 : 1,
        transform: phase === "out" ? "scale(1.06)" : "scale(1)",
        transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      <div className="splash-mark font-display text-6xl font-bold lowercase tracking-tight text-foreground">
        next<span className="text-primary">.</span>
      </div>
    </div>
  );
}
