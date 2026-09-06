import { useMemo } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Activity as ActivityIcon } from "lucide-react";
import type { PublicUser, Trade } from "@shared/schema";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { priceSol, shortCa, timeAgo, tokens as fmtTokens, sol } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TradeWithUser = Trade & { user: PublicUser | null };

export interface TradesTableProps {
  trades: TradeWithUser[];
  ticker: string;
  /** Maximum rows rendered (newest first). Default 100. */
  limit?: number;
  className?: string;
}

/**
 * Avatar for a trader: a linked Noxia user gets their custom/gradient avatar,
 * an anonymous wallet (no linked account — `user` is null) gets a deterministic
 * identicon keyed by the wallet address instead.
 */
export function PublicAvatar({
  user,
  wallet,
  size = 28,
  className,
}: {
  user: PublicUser | null;
  /** wallet address to key the identicon by when `user` is null */
  wallet?: string;
  size?: number;
  className?: string;
}) {
  if (user?.avatarUrl) {
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
  const seed = user?.avatarSeed ?? wallet ?? "?";
  const name = user?.username ?? wallet ?? "?";
  return <UserAvatar seed={seed} name={name} size={size} className={className} />;
}

/** "@username" for a linked user, or the shortened wallet address for an anonymous trader. */
export function TraderName({ user, wallet, mine = false }: { user: PublicUser | null; wallet: string; mine?: boolean }) {
  const t = useT();
  if (mine) return <>{t("chart.you")}</>;
  if (user) return <>@{user.username}</>;
  return <span className="font-mono">{shortCa(wallet, 4, 4)}</span>;
}

/** Shared empty-state box used by the market tabs. */
export function EmptyBox({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="surface flex flex-col items-center justify-center px-4 py-10 text-center">
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
    <div className={cn("surface overflow-hidden", className)}>
      {/* Mobile: stacked rows, no table chrome */}
      <ul className="feed-divide sm:hidden">
        {rows.map((tr, i) => {
          const buy = tr.side === "buy";
          const mine = !!user && !!user.walletAddress && user.walletAddress === tr.wallet;
          return (
            <motion.li
              key={tr.id}
              layout="position"
              initial={i === 0 ? { opacity: 0, backgroundColor: buy ? "rgba(34,197,94,0.18)" : "rgba(244,63,94,0.18)" } : false}
              animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className={cn("flex items-center gap-3 px-4 py-3", mine && "bg-primary/5")}
            >
              {tr.user ? (
                <Link href={`/u/${encodeURIComponent(tr.user.username)}`} className="shrink-0">
                  <PublicAvatar user={tr.user} wallet={tr.wallet} size={32} />
                </Link>
              ) : (
                <span className="shrink-0">
                  <PublicAvatar user={null} wallet={tr.wallet} size={32} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                      buy ? "bg-up/15 text-up" : "bg-down/15 text-down",
                    )}
                  >
                    {buy ? t("trade.buy") : t("trade.sell")}
                  </span>
                  <span className="truncate font-semibold">
                    {tr.user ? (
                      <Link href={`/u/${encodeURIComponent(tr.user.username)}`} className="hover:underline">
                        <TraderName user={tr.user} wallet={tr.wallet} mine={mine} />
                      </Link>
                    ) : (
                      <TraderName user={null} wallet={tr.wallet} mine={mine} />
                    )}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs tabular text-muted-foreground">
                  {fmtTokens(tr.tokens)} {ticker} · {priceSol(tr.priceSol)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="stat text-sm">{sol(tr.sol)}</div>
                <div className="text-[11px] text-muted-foreground" title={new Date(tr.createdAt).toLocaleString()}>
                  {timeAgo(tr.createdAt)}
                </div>
              </div>
            </motion.li>
          );
        })}
      </ul>

      {/* sm+: table */}
      <table className="hidden w-full min-w-[560px] text-sm sm:table">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t("trades.time")}</th>
            <th className="px-3 py-2 font-medium">{t("trades.type")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.sol")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.tokens")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("trades.price")}</th>
            <th className="px-3 py-2 font-medium">{t("trades.trader")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {rows.map((tr, i) => {
            const buy = tr.side === "buy";
            const mine = !!user && !!user.walletAddress && user.walletAddress === tr.wallet;
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
                      "inline-flex rounded-full px-1.5 py-0.5 text-xs font-semibold",
                      buy ? "bg-up/15 text-up" : "bg-down/15 text-down",
                    )}
                  >
                    {buy ? t("trade.buy") : t("trade.sell")}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{sol(tr.sol)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {fmtTokens(tr.tokens)} <span className="text-muted-foreground">{ticker}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">{priceSol(tr.priceSol)}</td>
                <td className="px-3 py-2">
                  {tr.user ? (
                    <Link
                      href={`/u/${encodeURIComponent(tr.user.username)}`}
                      className="inline-flex max-w-[160px] items-center gap-2 hover:underline"
                    >
                      <PublicAvatar user={tr.user} wallet={tr.wallet} size={20} />
                      <span className="truncate font-medium">
                        <TraderName user={tr.user} wallet={tr.wallet} mine={mine} />
                      </span>
                    </Link>
                  ) : (
                    <span className="inline-flex max-w-[160px] items-center gap-2">
                      <PublicAvatar user={null} wallet={tr.wallet} size={20} />
                      <span className="truncate font-medium">
                        <TraderName user={null} wallet={tr.wallet} mine={mine} />
                      </span>
                    </span>
                  )}
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
