import { useCallback, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const listeners = new Set<() => void>();

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme, persist: boolean) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }
  listeners.forEach((l) => l());
}

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

let initialized = false;
function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  // index.html applies the class before first paint; make sure we agree with it.
  // Next is dark by default: only an explicit "light" preference switches themes.
  applyTheme(storedTheme() ?? "dark", false);
}
init();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as Theme);
  const setTheme = useCallback((t: Theme) => applyTheme(t, true), []);
  const toggle = useCallback(() => applyTheme(readTheme() === "dark" ? "light" : "dark", true), []);
  return { theme, isDark: theme === "dark", setTheme, toggle };
}

/**
 * Theme switcher.
 * - "icon": a compact icon button (footer, toolbars)
 * - "switch": a labelled row with a Switch (menus, settings)
 */
export function ThemeToggle({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "switch";
  className?: string;
}) {
  const { isDark, toggle } = useTheme();

  if (variant === "switch") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        className={cn("flex w-full cursor-pointer select-none items-center gap-2 text-sm", className)}
      >
        {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        <span className="flex-1">Dark mode</span>
        <Switch checked={isDark} tabIndex={-1} className="pointer-events-none" aria-hidden />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
