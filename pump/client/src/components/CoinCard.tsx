import { memo } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { GraduationCap, MessageCircle, Users } from "lucide-react";
import type { CoinSummary } from "@shared/schema";
import { useT } from "@/i18n";
import { age, compactUsd, signedPct, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/UserAvatar";

export interface CoinCardProps {
  coin: CoinSummary;
  /** entrance animation (scale + glow) for coins that arrive live */
  highlight?: boolean;
  className?: string;
}

function CoinCardInner({ coin, highlight = false, className }: CoinCardProps) {
  const t = useT();
  const [, navigate] = useLocation();
  const solUsd = useSolUsd();
  const progress = Math.max(0, Math.min(1, coin.progress));
  const graduated = coin.curve.completed;

  const card = (
    <Link
      href={`/${coin.ca}`}
      aria-label={t("coin.openCoin", { name: coin.name })}
      className={cn(
        "card-hover group relative flex gap-3 overflow-hidden rounded-xl border border-border bg-card p-3 sm:gap-4 sm:p-4",
        highlight && "glow-primary border-primary/60",
        graduated && "border-violet/40",
        className,
      )}
    >
      <img
        src={coin.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-16 w-16 shrink-0 rounded-xl bg-muted object-cover sm:h-20 sm:w-20"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="truncate font-bold leading-tight">{coin.name}</span>
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">${coin.ticker}</span>
              {graduated && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet/15 px-1.5 py-0.5 text-[10px] font-bold text-violet"
                  title={t("coin.graduated")}
                >
                  <GraduationCap className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("coin.graduated")}</span>
                </span>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="shrink-0">{t("coin.createdBy")}</span>
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(`/u/${coin.creator.username}`);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`/u/${coin.creator.username}`);
                  }
                }}
                className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-foreground/80 hover:text-primary hover:underline"
              >
                {coin.creator.avatarUrl ? (
                  <img src={coin.creator.avatarUrl} alt="" className="h-3.5 w-3.5 rounded-full object-cover" />
                ) : (
                  <UserAvatar seed={coin.creator.avatarSeed} name={coin.creator.username} size={14} />
                )}
                <span className="truncate">@{coin.creator.username}</span>
              </span>
              <span className="shrink-0">· {t("coin.ago", { time: age(coin.createdAt) })}</span>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("coin.mcap")}</div>
            <div className="text-sm font-bold tabular text-primary">{compactUsd(coin.marketCapSol * solUsd)}</div>
            {Number.isFinite(coin.change24h) && coin.change24h !== 0 && (
              <div className={cn("text-[11px] font-semibold tabular", coin.change24h >= 0 ? "text-up" : "text-down")}>
                {signedPct(coin.change24h)}
              </div>
            )}
          </div>
        </div>

        {coin.description && (
          <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{coin.description}</p>
        )}

        <div className="mt-2.5 flex items-center gap-3">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={t("coin.progress")}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                graduated ? "bg-violet" : "bg-gradient-to-r from-primary/70 to-primary",
              )}
              style={{ width: `${Math.max(2, progress * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular text-muted-foreground">{Math.round(progress * 100)}%</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular text-muted-foreground" title={t("coin.holders")}>
            <Users className="h-3 w-3" />
            {coin.holders}
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular text-muted-foreground"
            title={t("comments.title")}
          >
            <MessageCircle className="h-3 w-3" />
            {coin.comments}
          </span>
        </div>
      </div>
    </Link>
  );

  if (!highlight) return card;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: [0.96, 1.02, 1] }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="animate-glow-pulse rounded-xl"
    >
      {card}
    </motion.div>
  );
}

export const CoinCard = memo(CoinCardInner);

/** Loading placeholder with the same footprint as CoinCard. */
export function CoinCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex gap-3 rounded-xl border border-border bg-card p-3 sm:gap-4 sm:p-4", className)} aria-hidden>
      <div className="h-16 w-16 shrink-0 animate-pulse rounded-xl bg-muted sm:h-20 sm:w-20" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between gap-2">
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-4 w-14 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
      </div>
    </div>
  );
}
