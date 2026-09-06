import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { Portfolio, WalletView } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The balance that opens the home screen in a trading app: one very large number with the
 * cents dimmed, the change underneath in green or red, and a single filled action button.
 *
 * Signed out (or with no wallet linked) it becomes the invitation to connect one, because
 * there is no balance to show until then — the funds live in the user's own wallet.
 */
export function BalanceHeader({ className }: { className?: string }) {
  const t = useT();
  const { user, openLogin } = useAuth();
  const connected = Boolean(user?.walletAddress);

  const wallet = useQuery<WalletView>({ queryKey: ["/api/wallet"], staleTime: 20_000, enabled: connected });
  const portfolio = useQuery<Portfolio>({ queryKey: ["/api/portfolio"], staleTime: 20_000, enabled: connected });

  const solUsd = wallet.data?.solUsd ?? 0;
  const totalSol = portfolio.data?.totalValueSol ?? wallet.data?.balanceSol ?? 0;
  const pnlSol = (portfolio.data?.realizedPnlSol ?? 0) + (portfolio.data?.unrealizedPnlSol ?? 0);
  const loading = connected && (wallet.isLoading || portfolio.isLoading);

  return (
    <section className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {loading ? (
          <>
            <Skeleton className="h-10 w-40" />
            <Skeleton className="mt-2 h-4 w-24" />
          </>
        ) : (
          <>
            <BigMoney usd={totalSol * solUsd} muted={!connected} />
            {connected ? (
              <div className={cn("mt-1 text-sm font-semibold tabular", pnlSol >= 0 ? "text-up" : "text-down")}>
                {pnlSol >= 0 ? "+" : "-"}
                {formatUsd(Math.abs(pnlSol) * solUsd)} <span className="font-medium text-muted-foreground">{t("home.pnlLabel")}</span>
              </div>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">{t("home.balanceHint")}</div>
            )}
          </>
        )}
      </div>

      {connected ? (
        <Button asChild size="lg" className="tap h-14 shrink-0 rounded-2xl px-8 text-base font-bold">
          <Link href="/wallet">
            <Plus className="h-4 w-4" />
            {t("home.addFunds")}
          </Link>
        </Button>
      ) : (
        <Button size="lg" className="tap h-14 shrink-0 rounded-2xl px-8 text-base font-bold" onClick={openLogin}>
          {t("nav.connect")}
        </Button>
      )}
    </section>
  );
}

/** "$1,234" in full contrast with ".56" dimmed, the way trading apps render a balance. */
function BigMoney({ usd, muted }: { usd: number; muted?: boolean }) {
  const safe = Number.isFinite(usd) ? usd : 0;
  const [whole, cents] = safe
    .toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .split(".");
  return (
    <div className={cn("text-[2.65rem] font-extrabold leading-none tracking-tight tabular", muted && "text-muted-foreground")}>
      {whole}
      <span className={cn("text-muted-foreground", muted && "opacity-70")}>.{cents}</span>
    </div>
  );
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 4 : 2 });
}
