import { useQuery } from "@tanstack/react-query";
import { Crown, Trophy } from "lucide-react";
import type { LeaderboardEntry } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { UserAvatar } from "@/components/UserAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { signedUsd, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Leaderboard() {
  const { user } = useAuth();
  const { data, isLoading, isError } = useQuery<LeaderboardEntry[]>({ queryKey: ["/api/leaderboard"] });

  const entries = data ?? [];
  const top3 = entries.slice(0, 3);
  const myRank = user ? entries.find((e) => e.user.id === user.id) : undefined;

  return (
    <PageShell className="pb-16">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Leaderboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">Top forecasters ranked by all-time profit and loss.</p>
          </div>
          {myRank && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm">
              Your rank: <span className="tabular font-bold text-primary">#{myRank.rank}</span>
            </div>
          )}
        </header>

        {isLoading ? (
          <>
            <div className="mb-8 grid gap-4 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-80 rounded-xl" />
          </>
        ) : isError ? (
          <Empty title="Couldn't load the leaderboard" body="Please try again in a moment." />
        ) : entries.length === 0 ? (
          <Empty title="No ranked traders yet" body="Make a trade and you could be the first name on the board." />
        ) : (
          <>
            {top3.length > 0 && <Podium top3={top3} currentUserId={user?.id} />}
            <RankTable entries={entries} currentUserId={user?.id} />
          </>
        )}
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------

const PODIUM_STYLES: Record<number, { ring: string; badge: string; label: string }> = {
  1: { ring: "ring-[#F5B301]", badge: "bg-[#F5B301] text-[#3b2a00]", label: "1st" },
  2: { ring: "ring-[#A8B4C4]", badge: "bg-[#A8B4C4] text-[#1D2B39]", label: "2nd" },
  3: { ring: "ring-[#CD7F32]", badge: "bg-[#CD7F32] text-white", label: "3rd" },
};

function Podium({ top3, currentUserId }: { top3: LeaderboardEntry[]; currentUserId?: number }) {
  // Visual order 2 · 1 · 3 on wide screens; rank order stacked on mobile.
  const ordered = [top3[1], top3[0], top3[2]].filter((e): e is LeaderboardEntry => !!e);
  return (
    <section className="mb-8 grid gap-4 sm:grid-cols-3 sm:items-end">
      {ordered.map((e) => {
        const style = PODIUM_STYLES[e.rank] ?? PODIUM_STYLES[3];
        const first = e.rank === 1;
        const me = e.user.id === currentUserId;
        return (
          <div
            key={e.user.id}
            className={cn(
              "relative flex flex-col items-center rounded-xl border bg-card p-5 text-center transition hover:shadow-md",
              first ? "border-[#F5B301]/50 sm:-order-none sm:pb-8 sm:pt-7" : "border-border",
              me && "ring-2 ring-primary/40",
            )}
            style={{ order: e.rank === 1 ? 0 : undefined }}
          >
            {first && (
              <Crown className="absolute -top-3 h-6 w-6 fill-[#F5B301] text-[#F5B301] drop-shadow" aria-hidden />
            )}
            <div className={cn("rounded-full ring-4", style.ring)}>
              <UserAvatar seed={e.user.avatarSeed} name={e.user.username} size={first ? 72 : 56} />
            </div>
            <span className={cn("mt-3 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide", style.badge)}>
              {style.label}
            </span>
            <div className="mt-2 max-w-full truncate font-semibold">
              {e.user.username}
              {me && <span className="ml-1 text-xs font-medium text-primary">(you)</span>}
            </div>
            <div className={cn("tabular mt-1 text-xl font-extrabold", e.pnl >= 0 ? "text-yes" : "text-no")}>
              {signedUsd(e.pnl)}
            </div>
            <div className="tabular mt-1 text-xs text-muted-foreground">
              {usd(e.volume, { compact: true, digits: 0 })} volume · {e.markets} market{e.markets === 1 ? "" : "s"}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function RankTable({ entries, currentUserId }: { entries: LeaderboardEntry[]; currentUserId?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="w-16 px-4 py-3">Rank</th>
            <th className="px-4 py-3">Trader</th>
            <th className="px-4 py-3 text-right">P&amp;L</th>
            <th className="px-4 py-3 text-right">Volume</th>
            <th className="px-4 py-3 text-right">Markets</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const me = e.user.id === currentUserId;
            return (
              <tr
                key={e.user.id}
                className={cn(
                  "border-b border-border transition-colors last:border-b-0 hover:bg-accent/40",
                  me && "bg-primary/5 hover:bg-primary/10",
                )}
              >
                <td className="px-4 py-3">
                  <RankBadge rank={e.rank} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <UserAvatar seed={e.user.avatarSeed} name={e.user.username} size={28} />
                    <span className="truncate font-medium">{e.user.username}</span>
                    {me && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        You
                      </span>
                    )}
                  </div>
                </td>
                <td className={cn("tabular px-4 py-3 text-right font-semibold", e.pnl >= 0 ? "text-yes" : "text-no")}>
                  {signedUsd(e.pnl)}
                </td>
                <td className="tabular px-4 py-3 text-right text-muted-foreground">{usd(e.volume, { digits: 0 })}</td>
                <td className="tabular px-4 py-3 text-right text-muted-foreground">{e.markets}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const style = PODIUM_STYLES[rank];
  if (style) {
    return (
      <span className={cn("tabular inline-grid h-6 w-6 place-items-center rounded-full text-xs font-bold", style.badge)}>
        {rank}
      </span>
    );
  }
  return <span className="tabular inline-block w-6 text-center text-muted-foreground">{rank}</span>;
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Trophy className="h-5 w-5" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
