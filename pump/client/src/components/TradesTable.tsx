import { useMemo } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Activity as ActivityIcon } from "lucide-react";
import type { PublicUser, Trade } from "@shared/schema";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { priceUsd, timeAgo, tokens as fmtTokens, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TradeWithUser = Trade & { user: PublicUser };

export interface TradesTableProps {
  trades: TradeWithUser[];
  ticker: string;
  /** Maximum rows rendered (newest first). Default 100. */
  limit?: number;
  className?: string;
}

/**
 * Avatar for a PublicUser: custom uploaded image when present, otherwise the
 * deterministic gradient avatar. Shared by the market components.
 */
export function PublicAvatar({ user, size = 28, className }: { user: PublicUser; size?: number; className?: string }) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return <UserAvatar seed={user.avatarSeed} name={user.username} size={size} className={className} />;
}

/** Shared empty-state box used by the market tabs. */
export function EmptyBox({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-10 text-center">
      {icon && (
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export function TradesTable({ trades, ticker, limit = 100, className }: TradesTableProps) {
  const t = useT();
  const { user } = useAuth();

  const rows = useMemo(() => {
    const byId = new Map<number, TradeWithUser>();
    for (const tr of trades) byId.set(tr.id, tr);
    return Array.from(byId.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id)
      .slice(0, limit);
  }, [trades, limit]);

  if (rows.length === 0) {
    return <EmptyBox icon={<ActivityIcon className="h-5 w-5" />}>{t("trades.empty")}</EmptyBox>;
  }

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border", className)}>
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t("trades.time")}</th>
            <th className="px-3 py-2 font-medium">{t("trades.type")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.usdc")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.tokens")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.price")}</th>
            <th className="px-3 py-2 font-medium">{t("trades.trader")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((tr, i) => {
            const buy = tr.side === "buy";
            const mine = !!user && user.id === tr.userId;
            return (
              <motion.tr
                key={tr.id}
                layout="position"
                initial={i === 0 ? { opacity: 0, backgroundColor: buy ? "rgba(34,197,94,0.18)" : "rgba(244,63,94,0.18)" } : false}
                animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                transition={{ duration: 0.8, ease: "easeOut" }}
                className={cn("tabular", mine && "bg-primary/5")}
              >
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={new Date(tr.createdAt).toLocaleString()}>
                  {timeAgo(tr.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-md px-1.5 py-0.5 text-xs font-semibold",
                      buy ? "bg-[#22c55e]/15 text-[#22c55e]" : "bg-[#f43f5e]/15 text-[#f43f5e]",
                    )}
                  >
                    {buy ? t("trade.buy") : t("trade.sell")}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{usd(tr.usdc)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {fmtTokens(tr.tokens)} <span className="text-muted-foreground">{ticker}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">{priceUsd(tr.price)}</td>
                <td className="px-3 py-2">
                  <Link
                    href={`/u/${encodeURIComponent(tr.user.username)}`}
                    className="inline-flex max-w-[160px] items-center gap-2 hover:underline"
                  >
                    <PublicAvatar user={tr.user} size={20} />
                    <span className="truncate font-medium">
                      {mine ? t("chart.you") : `@${tr.user.username}`}
                    </span>
                  </Link>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default TradesTable;
