import { useQuery } from "@tanstack/react-query";
import type { Portfolio, WalletView } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { useDepositSheet } from "@/components/DepositSheet";
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
  const deposit = useDepositSheet();
  // Signed in is enough to deposit: the account carries its own wallet.
  const signedIn = Boolean(user);
  const connected = Boolean(user?.walletAddress);

  // A deposit arrives on its own schedule: the balance watches for it rather than
  // waiting for a reload.
  const wallet = useQuery<WalletView>({
    queryKey: ["/api/wallet"],
    staleTime: 8_000,
    refetchInterval: 12_000,
    refetchOnWindowFocus: true,
    enabled: connected,
  });
  const portfolio = useQuery<Portfolio>({
    queryKey: ["/api/portfolio"],
    staleTime: 8_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled: connected,
  });

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
            <BigMoney usd={totalSol * solUsd} muted={!signedIn} />
            {connected ? (
              <div className={cn("mt-1 text-sm font-semibold tabular", pnlSol >= 0 ? "text-up" : "text-down")}>
                {pnlSol >= 0 ? "+" : "-"}
                {formatUsd(Math.abs(pnlSol) * solUsd)} <span className="font-medium text-muted-foreground">{t("home.pnlLabel")}</span>
              </div>
            ) : signedIn ? (
              // The wallet is still being linked. It takes a moment and nothing is
              // required of the user, so the balance simply reads zero until then.
              <div className="mt-1 text-sm font-semibold tabular text-muted-foreground">
                {formatUsd(0)} <span className="font-medium text-muted-foreground">{t("home.pnlLabel")}</span>
              </div>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">{t("home.balanceHint")}</div>
            )}
          </>
        )}
      </div>

      {signedIn ? (
        <>
          <Button
            size="lg"
            onClick={deposit.open}
            className="tap h-[52px] shrink-0 rounded-[14px] border-2 border-primary/60 px-9 text-[19px] font-semibold shadow-none"
          >
            {t("home.deposit")}
          </Button>
          {deposit.sheet}
        </>
      ) : (
        <Button size="lg" className="tap h-14 shrink-0 rounded-2xl px-8 text-base font-bold" onClick={openLogin}>
          {t("nav.login")}
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
