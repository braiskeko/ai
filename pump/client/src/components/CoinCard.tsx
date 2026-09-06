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
  /** "card" (grid tile, profile/portfolio) or "row" (full-bleed social feed row, home) */
  variant?: "card" | "row";
}

function CoinCardInner({ coin, highlight = false, className, variant = "card" }: CoinCardProps) {
  const t = useT();
  const solUsd = useSolUsd();
  const progress = Math.max(0, Math.min(1, coin.progress));
  const graduated = coin.curve.completed;

  const inner = variant === "row" ? (
    <RowBody coin={coin} highlight={highlight} className={className} progress={progress} graduated={graduated} solUsd={solUsd} t={t} />
  ) : (
    <CardBody coin={coin} highlight={highlight} className={className} progress={progress} graduated={graduated} solUsd={solUsd} t={t} />
  );

  if (!highlight) return inner;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: [0.96, 1.02, 1] }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={variant === "row" ? "animate-glow-pulse" : "animate-glow-pulse rounded-3xl"}
    >
      {inner}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Row: full-bleed social-feed row (home timeline)
// ---------------------------------------------------------------------------

type BodyProps = {
  coin: CoinSummary;
  highlight: boolean;
  className?: string;
  progress: number;
  graduated: boolean;
  solUsd: number;
  t: ReturnType<typeof useT>;
};

function RowBody({ coin, highlight, className, progress, graduated, solUsd, t }: BodyProps) {
  const [, navigate] = useLocation();
  const goToCoin = () => navigate(`/${coin.ca}`);

  return (
    <div
      className={cn(
        "group feed-row tap",
        highlight && "bg-primary/[0.06]",
        className,
      )}
    >
      <Link
        href={`/${coin.ca}`}
        aria-label={t("coin.openCoin", { name: coin.name })}
        className="absolute inset-0"
      />
      <img
        src={coin.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn(
          "relative h-14 w-14 shrink-0 rounded-2xl bg-muted object-cover",
          highlight && "ring-2 ring-primary/60",
        )}
      />

      <div className="relative min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="truncate font-bold leading-tight">{coin.name}</span>
          <span className="shrink-0 text-xs font-semibold text-muted-foreground">${coin.ticker}</span>
          {graduated && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet/15 px-1.5 py-0.5 text-[10px] font-bold text-violet"
              title={t("coin.graduated")}
            >
              <GraduationCap className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {coin.creator.avatarUrl ? (
            <img src={coin.creator.avatarUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full object-cover" />
          ) : (
            <UserAvatar seed={coin.creator.avatarSeed} name={coin.creator.username} size={14} />
          )}
          <span className="truncate">@{coin.creator.username}</span>
          <span className="shrink-0">· {age(coin.createdAt)}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5" title={t("coin.holders")}>
            <Users className="h-3 w-3" />
            {coin.holders}
          </span>
        </div>
      </div>

      <div className="relative flex shrink-0 items-center gap-2">
        <div className="text-right">
          <div className="stat text-base leading-tight text-foreground">{compactUsd(coin.marketCapSol * solUsd)}</div>
          {Number.isFinite(coin.change24h) && coin.change24h !== 0 ? (
            <div className={cn("text-[11px] font-semibold tabular", coin.change24h >= 0 ? "text-up" : "text-down")}>
              {signedPct(coin.change24h)}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground">·</div>
          )}
          <div
            className="mt-1 h-1 w-14 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={t("coin.progress")}
          >
            <div
              className={cn("h-full rounded-full", graduated ? "bg-violet" : "bg-primary")}
              style={{ width: `${Math.max(4, progress * 100)}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            goToCoin();
          }}
          className="tap inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3 text-xs font-bold text-primary-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          {t("trade.buy")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card: grid tile (profile, portfolio, created-coins tab)
// ---------------------------------------------------------------------------

function CardBody({ coin, highlight, className, progress, graduated, solUsd, t }: BodyProps) {
  const [, navigate] = useLocation();
  return (
    <Link
      href={`/${coin.ca}`}
      aria-label={t("coin.openCoin", { name: coin.name })}
      className={cn(
        "surface card-hover tap group relative flex gap-3 overflow-hidden p-3 sm:gap-4 sm:p-4",
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
        className="h-20 w-20 shrink-0 rounded-2xl bg-muted object-cover sm:h-24 sm:w-24"
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
            <div className="label">{t("coin.mcap")}</div>
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
}

export const CoinCard = memo(CoinCardInner);

/** Loading placeholder with the same footprint as CoinCard. */
export function CoinCardSkeleton({ className, variant = "card" }: { className?: string; variant?: "card" | "row" }) {
  if (variant === "row") {
    return (
      <div className={cn("flex items-center gap-3 px-4 py-3", className)} aria-hidden>
        <div className="h-14 w-14 shrink-0 animate-pulse rounded-2xl bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-1.5 text-right">
          <div className="ml-auto h-4 w-16 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-3 w-10 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }
  return (
    <div className={cn("surface flex gap-3 p-3 sm:gap-4 sm:p-4", className)} aria-hidden>
      <div className="h-20 w-20 shrink-0 animate-pulse rounded-2xl bg-muted sm:h-24 sm:w-24" />
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
