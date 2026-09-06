import { Link } from "wouter";
import { useConfig } from "@/hooks/useConfig";
import { useLiveStatus } from "@/lib/useLive";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

const LINKS: { href: string; label: string }[] = [
  { href: "/markets", label: "Markets" },
  { href: "/activity", label: "Activity" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/create", label: "Create a market" },
];

function LiveDot() {
  const status = useLiveStatus();
  const label = status === "connected" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`Realtime feed: ${label.toLowerCase()}`}>
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 rounded-full",
          status === "connected" && "bg-yes animate-pulse-dot",
          status === "connecting" && "bg-primary animate-pulse-dot",
          status === "offline" && "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

export function Footer() {
  const config = useConfig();
  const year = new Date().getFullYear();
  const chain = config?.chain;

  return (
    <footer className="mt-auto border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Link href="/" className="flex items-center gap-2 text-foreground">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-black text-primary-foreground">
              F
            </span>
            <span className="font-semibold">{config?.appName ?? "Foresight"}</span>
          </Link>
          <span className="hidden text-border sm:inline">|</span>
          <span className="text-xs">
            &copy; {year}. Forecasts are not financial advice.
            {chain && (
              <>
                {" "}
                Settled in USDC on {chain.name}
                {chain.testnet ? " (testnet)" : ""}.
              </>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-xs transition-colors hover:text-foreground">
                {l.label}
              </Link>
            ))}
          </nav>
          <LiveDot />
          <ThemeToggle className="h-8 w-8" />
        </div>
      </div>
    </footer>
  );
}
