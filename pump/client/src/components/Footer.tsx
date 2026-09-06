import { Link } from "wouter";
import { useConfig } from "@/hooks/useConfig";
import { useLiveStatus } from "@/lib/useLive";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher, useT } from "@/i18n";
import { pct } from "@/lib/format";
import { cn } from "@/lib/utils";

const LINKS: { href: string; key: string }[] = [
  { href: "/", key: "nav.home" },
  { href: "/create", key: "nav.create" },
  { href: "/activity", key: "nav.activity" },
  { href: "/portfolio", key: "nav.portfolio" },
  { href: "/wallet", key: "nav.wallet" },
];

export function LiveDot({ className }: { className?: string }) {
  const t = useT();
  const status = useLiveStatus();
  const label =
    status === "connected" ? t("common.live") : status === "connecting" ? t("common.connecting") : t("common.offline");
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      title={t("footer.liveFeed", { status: label })}
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 rounded-full",
          status === "connected" && "bg-primary animate-pulse-dot",
          status === "connecting" && "bg-gold animate-pulse-dot",
          status === "offline" && "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

export function Footer() {
  const config = useConfig();
  const t = useT();
  const year = new Date().getFullYear();
  const chain = config?.chain;
  const appName = config?.appName ?? t("app.name");

  return (
    <footer className="mt-auto border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Link href="/" className="flex items-center gap-2 text-foreground">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-black text-primary-foreground">
              N
            </span>
            <span className="font-semibold">{appName}</span>
          </Link>
          <span className="hidden text-border sm:inline">|</span>
          <span className="text-xs">
            &copy; {year}. {t("footer.disclaimer", { app: appName })}
            {chain && (
              <>
                {" "}
                {t("footer.settledOn", { chain: "Solana" })}
                {chain.testnet ? ` (${chain.cluster})` : ""}.
              </>
            )}
            {config && (
              <>
                {" "}
                {t("footer.fee", { fee: pct(config.swapFee, 1), share: pct(config.creatorFeeShare) })}
              </>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <nav aria-label={t("footer.links")} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-xs transition-colors hover:text-foreground">
                {t(l.key)}
              </Link>
            ))}
          </nav>
          <LiveDot />
          <LanguageSwitcher className="h-8" />
          <ThemeToggle className="h-8 w-8" />
        </div>
      </div>
    </footer>
  );
}
