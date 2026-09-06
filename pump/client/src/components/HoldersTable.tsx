import { useMemo } from "react";
import { Link } from "wouter";
import { Users } from "lucide-react";
import type { CoinDetail, HolderRow } from "@shared/schema";
import { EmptyBox, PublicAvatar, TraderName } from "@/components/TradesTable";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { tokens as fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface HoldersTableProps {
  /** Only the fields the table needs from a CoinDetail. */
  coin: Pick<CoinDetail, "topHolders" | "ticker">;
  className?: string;
}

const sharePct = (share: number) => {
  const p = share * 100;
  if (p === 0) return "0%";
  if (p < 0.01) return "<0.01%";
  return `${p.toFixed(2)}%`;
};

export function HoldersTable({ coin, className }: HoldersTableProps) {
  const t = useT();
  const { user } = useAuth();

  const holders = useMemo<HolderRow[]>(
    () =>
      coin.topHolders
        .filter((h) => h.tokens > 1e-9)
        .slice()
        .sort((a, b) => (b.isCurve === a.isCurve ? b.tokens - a.tokens : b.isCurve ? 1 : -1)),
    [coin.topHolders],
  );

  if (holders.length === 0) {
    return <EmptyBox icon={<Users className="h-5 w-5" />}>{t("home.empty")}</EmptyBox>;
  }

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border", className)}>
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="w-10 px-3 py-2 font-medium">{t("holders.rank")}</th>
            <th className="px-3 py-2 font-medium">{t("holders.holder")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("holders.tokens")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("holders.share")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular">
          {holders.map((h, i) => {
            const mine = !!user?.walletAddress && user.walletAddress === h.wallet;
            return (
              <tr key={h.wallet} className={cn(h.isCurve ? "bg-muted/30" : mine && "bg-primary/5")}>
                <td className="px-3 py-2 text-muted-foreground">{h.isCurve ? "—" : i + 1}</td>
                <td className="px-3 py-2">
                  {h.isCurve ? (
                    <span className="inline-flex items-center gap-2 font-medium">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
                          <path d="M4 18c6-1 8-6 9-10 1 5 3 8 7 9" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      {t("holders.curve")}
                    </span>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      {h.user ? (
                        <Link href={`/u/${encodeURIComponent(h.user.username)}`} className="inline-flex min-w-0 items-center gap-2 hover:underline">
                          <PublicAvatar user={h.user} wallet={h.wallet} size={24} />
                          <span className="truncate font-medium">
                            <TraderName user={h.user} wallet={h.wallet} mine={mine} />
                          </span>
                        </Link>
                      ) : (
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <PublicAvatar user={null} wallet={h.wallet} size={24} />
                          <span className="truncate font-medium">
                            <TraderName user={null} wallet={h.wallet} mine={mine} />
                          </span>
                        </span>
                      )}
                      {h.isCreator && (
                        <span className="shrink-0 rounded-md bg-[#fbbf24]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#fbbf24]">
                          {t("holders.creator")}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {fmtTokens(h.tokens)} <span className="text-muted-foreground">{coin.ticker}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                  <div className="flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(2, h.share * 100))}%` }}
                      />
                    </span>
                    {sharePct(h.share)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default HoldersTable;
