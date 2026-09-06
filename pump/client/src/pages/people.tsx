import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Share2, Users } from "lucide-react";
import type { LeaderboardRange, MyRank, TraderRank } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { ActivityFeed } from "@/pages/feed";
import { PublicAvatar } from "@/components/TradesTable";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { compactUsd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab = "following" | "leaderboard";
const RANGES: LeaderboardRange[] = ["24h", "7d", "30d", "all"];

function medal(rank: number): string | null {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return null;
}

function YourRankCard({ range }: { range: LeaderboardRange }) {
  const t = useT();
  const solUsd = useSolUsd();
  const { toast } = useToast();
  const { user } = useAuth();
  const myRank = useQuery<MyRank>({ queryKey: [`/api/traders/me?range=${range}`], enabled: !!user?.walletAddress, staleTime: 15_000 });

  if (!user?.walletAddress) return null;
  const pnlSol = myRank.data?.pnlSol ?? 0;

  const share = async () => {
    const text = t("people.shareText", { rank: myRank.data ? `#${myRank.data.rank}` : "?" });
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        toast({ title: t("common.copied") });
      }
    } catch {
      /* the user dismissed the share sheet — nothing to do */
    }
  };

  return (
    <div className="surface flex items-center gap-3 p-4">
      <UserAvatar seed={user.avatarSeed} name={user.username} size={44} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-muted-foreground">{t("people.yourRank")}</div>
        <div className="text-lg font-extrabold tabular">{myRank.data ? `#${myRank.data.rank.toLocaleString()}` : "—"}</div>
      </div>
      <div className={cn("text-right text-base font-bold tabular", pnlSol >= 0 ? "text-up" : "text-down")}>
        {pnlSol >= 0 ? "+" : "-"}
        {compactUsd(Math.abs(pnlSol) * solUsd)}
      </div>
      <button
        type="button"
        onClick={() => void share()}
        aria-label={t("people.share")}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"
      >
        <Share2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function LeaderboardRow({ trader }: { trader: TraderRank }) {
  const t = useT();
  const solUsd = useSolUsd();
  const badge = medal(trader.rank);
  const href = trader.user ? `/${encodeURIComponent(trader.user.username)}` : null;
  const name = trader.user?.username ?? t("people.anonymousTrader");

  const body = (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="grid w-6 shrink-0 place-items-center text-sm font-bold text-muted-foreground">
        {badge ?? trader.rank}
      </span>
      <PublicAvatar user={trader.user} wallet={trader.wallet} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold">{name}</div>
        {trader.user && <div className="truncate text-xs text-muted-foreground">@{trader.user.username}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={cn("text-sm font-bold tabular", trader.pnlSol >= 0 ? "text-up" : "text-down")}>
          {trader.pnlSol >= 0 ? "+" : "-"}
          {compactUsd(Math.abs(trader.pnlSol) * solUsd)}
        </div>
        {trader.topTokens.length > 0 && (
          <div className="mt-1 flex items-center justify-end gap-1">
            {trader.topTokens.map((tk) => (
              <img key={tk.ca} src={tk.imageUrl} alt="" className="h-4 w-4 rounded-full bg-muted object-cover" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function PeoplePage() {
  const t = useT();
  const { user } = useAuth();
  // Following opens first: what the people you follow are doing beats a ranking.
  const [tab, setTab] = useState<Tab>("following");
  const [range, setRange] = useState<LeaderboardRange>("24h");

  useEffect(() => {
    document.title = `${t("people.title")} · ${t("app.name")}`;
  }, [t]);

  const leaderboard = useQuery<TraderRank[]>({
    queryKey: [`/api/traders?range=${range}&limit=100`],
    staleTime: 20_000,
    enabled: tab === "leaderboard",
  });
  const following = useQuery<TraderRank[]>({
    queryKey: [`/api/traders?range=all&scope=following&limit=200`],
    staleTime: 20_000,
    enabled: tab === "following" && !!user,
  });

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex border-b border-border">
          {(["following", "leaderboard"] as Tab[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                "-mb-px flex-1 border-b-2 py-3 text-center text-base font-bold transition-colors",
                tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
              )}
            >
              {k === "following" ? t("people.following") : t("people.leaderboard")}
            </button>
          ))}
        </div>

        {tab === "leaderboard" ? (
          <div className="space-y-4">
            <div className="no-scrollbar flex gap-2 overflow-x-auto">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "tap h-8 shrink-0 rounded-full border px-3 text-xs font-bold transition-colors",
                    range === r ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground",
                  )}
                >
                  {t(`people.range.${r}`)}
                </button>
              ))}
            </div>

            <YourRankCard range={range} />

            {leaderboard.isLoading ? (
              <div className="surface divide-y divide-border/70" aria-hidden>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (leaderboard.data?.length ?? 0) === 0 ? (
              <div className="surface flex flex-col items-center px-6 py-14 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                  <Users className="h-5 w-5" />
                </div>
                <h3 className="mt-3 font-semibold">{t("people.emptyLeaderboard")}</h3>
              </div>
            ) : (
              <ul className="surface divide-y divide-border/70 overflow-hidden">
                {(leaderboard.data ?? []).map((trader) => (
                  <li key={trader.wallet}>
                    <LeaderboardRow trader={trader} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : !user ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
              <Users className="h-5 w-5" />
            </div>
            <h3 className="font-semibold">{t("people.followingLoginTitle")}</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("people.followingLoginHint")}</p>
          </div>
        ) : following.isLoading ? (
          <div className="surface divide-y divide-border/70" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (following.data?.length ?? 0) === 0 ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
              <Users className="h-5 w-5" />
            </div>
            <h3 className="font-semibold">{t("people.emptyFollowing")}</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("people.emptyFollowingHint")}</p>
            <Link href="/search?tab=traders" className="mt-4 text-sm font-bold text-primary">
              {t("people.findTraders")}
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Who you follow, then what they have been doing — buys, sells and theses. */}
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4">
              {(following.data ?? []).map((trader) => (
                <Link
                  key={trader.wallet}
                  href={trader.user ? `/${encodeURIComponent(trader.user.username)}` : "/people"}
                  className="tap flex w-20 shrink-0 flex-col items-center gap-1.5"
                >
                  <PublicAvatar user={trader.user} wallet={trader.wallet} size={52} />
                  <span className="w-full truncate text-center text-xs font-semibold">
                    {trader.user?.username ?? t("people.anonymousTrader")}
                  </span>
                </Link>
              ))}
            </div>
            <ActivityFeed scope="following" />
          </div>
        )}
      </div>
    </PageShell>
  );
}
