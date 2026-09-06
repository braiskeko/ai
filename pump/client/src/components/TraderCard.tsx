import { Link } from "wouter";
import { X } from "lucide-react";
import type { TraderRank } from "@shared/schema";
import { PublicAvatar } from "@/components/TradesTable";
import { useFollowMutation } from "@/hooks/useFollow";
import { useT } from "@/i18n";
import { compactUsd, shortAddress, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Indigo when not yet followed, a muted pill once followed — matches the reference app. */
export function FollowButton({
  wallet,
  isFollowing,
  className,
}: {
  wallet: string;
  isFollowing: boolean;
  className?: string;
}) {
  const t = useT();
  const { toggle, pending } = useFollowMutation();
  // Follows are keyed by wallet: an account whose wallet has not been set up yet
  // cannot be followed, and offering the button would only fail on the tap.
  if (!wallet) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(wallet, isFollowing);
      }}
      disabled={pending}
      aria-pressed={isFollowing}
      className={cn(
        "tap inline-flex h-9 shrink-0 items-center justify-center rounded-full px-4 text-sm font-bold transition-colors disabled:opacity-60",
        isFollowing ? "bg-muted text-foreground" : "bg-primary text-primary-foreground",
        className,
      )}
    >
      {isFollowing ? t("people.following") : t("people.follow")}
    </button>
  );
}

/** "@handle" for a linked user, or the shortened wallet for an anonymous trader. */
function traderName(trader: TraderRank): string {
  return trader.user ? trader.user.username : shortAddress(trader.wallet);
}

function traderHref(trader: TraderRank): string | null {
  return trader.user ? `/${encodeURIComponent(trader.user.username)}` : null;
}

/** Compact horizontal-strip card: avatar, name, followers + PnL, Follow button, optional × to dismiss. */
export function TraderStripCard({ trader, onRemove }: { trader: TraderRank; onRemove?: () => void }) {
  const t = useT();
  const solUsd = useSolUsd();
  const href = traderHref(trader);
  const body = (
    <>
      <div className="flex items-center gap-2">
        <PublicAvatar user={trader.user} wallet={trader.wallet} size={40} />
        <div className="min-w-0 flex-1 truncate font-bold">{traderName(trader)}</div>
      </div>
      <div className="mt-2 truncate text-xs text-muted-foreground">
        {t("people.followersCount", { n: new Intl.NumberFormat("en-US", { notation: "compact" }).format(trader.followers) })}
        {" · "}
        <span className={trader.pnlSol >= 0 ? "text-up" : "text-down"}>
          {trader.pnlSol >= 0 ? "+" : "-"}
          {compactUsd(Math.abs(trader.pnlSol) * solUsd)}
        </span>
      </div>
    </>
  );
  return (
    <div className="relative w-[210px] shrink-0 rounded-2xl border border-border bg-card p-3">
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("common.close")}
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {href ? (
        <Link href={href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
      <FollowButton wallet={trader.wallet} isFollowing={trader.isFollowing} className="mt-3 w-full" />
    </div>
  );
}

/** Full-width result row for the search page's Traders tab. */
export function TraderRow({ trader, onRemove }: { trader: TraderRank; onRemove?: () => void }) {
  const t = useT();
  const solUsd = useSolUsd();
  const href = traderHref(trader);
  const row = (
    <div className="feed-row">
      <PublicAvatar user={trader.user} wallet={trader.wallet} size={44} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold">{traderName(trader)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {t("people.followersCount", { n: new Intl.NumberFormat("en-US", { notation: "compact" }).format(trader.followers) })}
          {" · "}
          <span className={trader.pnlSol >= 0 ? "text-up" : "text-down"}>
            {trader.pnlSol >= 0 ? "+" : "-"}
            {compactUsd(Math.abs(trader.pnlSol) * solUsd)}
          </span>
        </div>
      </div>
      <FollowButton wallet={trader.wallet} isFollowing={trader.isFollowing} />
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          aria-label={t("common.close")}
          className="grid h-8 w-8 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="relative block">
      {row}
    </Link>
  ) : (
    row
  );
}
