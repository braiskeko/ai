import { useMemo } from "react";
import { Link } from "wouter";
import { Heart, Users } from "lucide-react";
import type { CoinDetail, CommentView, HolderRow } from "@shared/schema";
import { TOTAL_SUPPLY } from "@shared/schema";
import { EmptyBox, PublicAvatar, TraderName } from "@/components/TradesTable";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { compactUsd, tokens as fmtTokens, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface HoldersTableProps {
  /** Only the fields the table needs from a CoinDetail. */
  coin: Pick<CoinDetail, "topHolders" | "ticker" | "commentsList" | "priceSol">;
  className?: string;
}

const sharePct = (share: number) => {
  const p = share * 100;
  if (p === 0) return "0%";
  if (p < 0.01) return "<0.01%";
  return `${p.toFixed(2)}%`;
};

/**
 * Who holds this coin, biggest position first, with what that position is worth
 * in dollars — and, where the wallet traded here, the market cap they bought at
 * and how far they are up or down. A holder's latest thesis hangs off their row.
 */
export function HoldersTable({ coin, className }: HoldersTableProps) {
  const t = useT();
  const solUsd = useSolUsd();
  const { user } = useAuth();

  const holders = useMemo<HolderRow[]>(
    () =>
      coin.topHolders
        .filter((h) => h.tokens > 1e-9)
        .slice()
        .sort((a, b) => (b.isCurve === a.isCurve ? b.tokens - a.tokens : b.isCurve ? 1 : -1)),
    [coin.topHolders],
  );

  const thesisByWallet = useMemo(() => {
    const map = new Map<string, CommentView>();
    for (const c of coin.commentsList) {
      if (c.kind !== "thesis" || !c.wallet) continue;
      const current = map.get(c.wallet);
      if (!current || Date.parse(c.createdAt) > Date.parse(current.createdAt)) map.set(c.wallet, c);
    }
    return map;
  }, [coin.commentsList]);

  if (holders.length === 0) {
    return <EmptyBox icon={<Users className="h-5 w-5" />}>{t("home.empty")}</EmptyBox>;
  }

  return (
    <ul className={cn("feed-divide", className)}>
      {holders.map((h, i) => {
        const mine = !!user?.walletAddress && user.walletAddress === h.wallet;
        const valueUsd = h.tokens * coin.priceSol * solUsd;
        // Average entry as the market cap they bought at — how traders quote it.
        const entryMcapUsd = h.tokens > 0 && h.costBasisSol > 0 ? (h.costBasisSol / h.tokens) * TOTAL_SUPPLY * solUsd : 0;
        const costUsd = h.costBasisSol * solUsd;
        const returnPct = costUsd > 0 ? (valueUsd - costUsd) / costUsd : null;

        return (
          <li key={h.wallet} className={cn("px-1 py-3", mine && !h.isCurve && "rounded-2xl bg-primary/5 px-3")}>
            <div className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-xs tabular text-muted-foreground">{h.isCurve ? "—" : i + 1}</span>
              {h.isCurve ? (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
                    <path d="M4 18c6-1 8-6 9-10 1 5 3 8 7 9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : h.user ? (
                <Link href={`/u/${encodeURIComponent(h.user.username)}`} className="shrink-0">
                  <PublicAvatar user={h.user} wallet={h.wallet} size={40} />
                </Link>
              ) : (
                <span className="shrink-0">
                  <PublicAvatar user={null} wallet={h.wallet} size={40} />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[15px] font-bold">
                    {h.isCurve ? (
                      t("holders.curve")
                    ) : h.user ? (
                      <Link href={`/u/${encodeURIComponent(h.user.username)}`} className="hover:underline">
                        <TraderName user={h.user} wallet={h.wallet} mine={mine} />
                      </Link>
                    ) : (
                      <TraderName user={null} wallet={h.wallet} mine={mine} />
                    )}
                  </span>
                  {h.isCreator && (
                    <span className="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold">
                      {t("holders.creator")}
                    </span>
                  )}
                </div>
                <div className="truncate text-[13px] text-muted-foreground tabular">
                  {entryMcapUsd > 0
                    ? t("holders.avgEntry", { mcap: compactUsd(entryMcapUsd) })
                    : `${fmtTokens(h.tokens)} ${coin.ticker} · ${sharePct(h.share)}`}
                </div>
              </div>

              <div className="shrink-0 text-right">
                <div className="text-[15px] font-bold tabular leading-tight">{compactUsd(valueUsd)}</div>
                {returnPct === null ? (
                  <div className="text-[13px] tabular text-muted-foreground">{sharePct(h.share)}</div>
                ) : (
                  <div className={cn("text-[13px] font-semibold tabular", returnPct >= 0 ? "text-up" : "text-down")}>
                    {returnPct >= 0 ? "+" : "-"}{(Math.abs(returnPct) * 100).toFixed(2)}%
                  </div>
                )}
              </div>
            </div>

            <Thesis comment={thesisByWallet.get(h.wallet)} />
          </li>
        );
      })}
    </ul>
  );
}

/** A holder's thesis, hanging off their row by the same L-connector the feed uses. */
function Thesis({ comment }: { comment: CommentView | undefined }) {
  if (!comment) return null;
  return (
    <div className="ml-9 mt-1.5 border-l border-dotted border-border pl-4">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.body}</p>
      <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Heart className="h-3.5 w-3.5" />
        <span className="tabular">{comment.likes.length}</span>
      </div>
    </div>
  );
}

export default HoldersTable;
