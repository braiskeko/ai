import { useMemo } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity as ActivityIcon, CalendarDays, Coins, Pencil, PieChart, RefreshCw } from "lucide-react";
import type { ActivityItem, CoinSummary, PublicUser } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard, CoinCardSkeleton } from "@/components/CoinCard";
import { EmptyBox, PublicAvatar } from "@/components/TradesTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { useLiveTrades } from "@/lib/useLive";
import { compactUsd, priceSol, timeAgo, tokens as fmtTokens, useSolUsd, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/not-found";

interface PublicProfile {
  user: PublicUser;
  createdCoins: CoinSummary[];
  joinedAt: string;
  holdingsCount: number;
}

const ACTIVITY_KEY = "/api/activity?limit=200";
const RECENT_TRADES = 30;

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{icon}</span>
      <div className="min-w-0">
        <div className="truncate label">{label}</div>
        <div className="truncate text-lg font-bold leading-tight tabular">{value}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent trades by this user (derived from the global feed + live socket)
// ---------------------------------------------------------------------------

interface UserTrade {
  id: number;
  at: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  priceSol: number;
  coin: { ca: string; name: string; ticker: string; imageUrl: string };
}

function RecentTrades({ userId }: { userId: number }) {
  const t = useT();
  const solUsd = useSolUsd();
  const activity = useQuery<ActivityItem[]>({ queryKey: [ACTIVITY_KEY], staleTime: 15_000 });
  const live = useLiveTrades(200);

  const trades = useMemo<UserTrade[]>(() => {
    const byId = new Map<number, UserTrade>();
    for (const { coin, trade } of live) {
      if (trade.userId !== userId) continue;
      byId.set(trade.id, { id: trade.id, at: trade.createdAt, side: trade.side, sol: trade.sol, tokens: trade.tokens, priceSol: trade.priceSol, coin });
    }
    for (const a of activity.data ?? []) {
      if (a.user?.id !== userId || byId.has(a.trade.id)) continue;
      byId.set(a.trade.id, { id: a.trade.id, at: a.trade.createdAt, side: a.trade.side, sol: a.trade.sol, tokens: a.trade.tokens, priceSol: a.trade.priceSol, coin: a.coin });
    }
    return Array.from(byId.values())
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id)
      .slice(0, RECENT_TRADES);
  }, [live, activity.data, userId]);

  if (activity.isLoading) {
    return (
      <div className="space-y-2" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }
  if (trades.length === 0) {
    return <EmptyBox icon={<ActivityIcon className="h-5 w-5" />}>{t("profile.noTrades")}</EmptyBox>;
  }
  return (
    <ul className="overflow-hidden rounded-xl border border-border bg-card">
      {trades.map((tr) => {
        const buy = tr.side === "buy";
        return (
          <li key={tr.id} className="flex items-center gap-3 border-b border-border p-3 last:border-b-0 hover:bg-accent/40">
            <span className={cn("inline-flex w-12 shrink-0 justify-center rounded-md px-1.5 py-0.5 text-xs font-semibold", buy ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
              {buy ? t("trade.buy") : t("trade.sell")}
            </span>
            <Link href={`/${tr.coin.ca}`} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
              <img src={tr.coin.imageUrl} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded-lg bg-muted object-cover" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {tr.coin.name} <span className="text-xs font-medium text-muted-foreground">${tr.coin.ticker}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground tabular">
                  {fmtTokens(tr.tokens)} {tr.coin.ticker} · {priceSol(tr.priceSol)}
                </div>
              </div>
            </Link>
            <div className="shrink-0 text-right">
              <div className={cn("text-sm font-semibold tabular", buy ? "text-up" : "text-down")}>
                {buy ? "+" : "-"}
                {usd(tr.sol, solUsd)}
              </div>
              <div className="text-xs text-muted-foreground" title={new Date(tr.at).toLocaleString()}>
                {timeAgo(tr.at)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ProfileSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-6 sm:flex-row">
        <Skeleton className="h-24 w-24 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <CoinCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const t = useT();
  const solUsd = useSolUsd();
  const params = useParams<{ username: string }>();
  const username = decodeURIComponent(params.username ?? "");
  const { user: me } = useAuth();

  const profile = useQuery<PublicProfile>({
    queryKey: [`/api/users/${encodeURIComponent(username)}`],
    enabled: username.length > 0,
    staleTime: 30_000,
  });

  if (!username || (profile.isError && isNotFound(profile.error))) {
    return <NotFound title={t("profile.notFound")} hint={t("profile.notFoundHint", { app: t("app.name"), username })} />;
  }

  if (profile.isLoading) {
    return (
      <PageShell>
        <ProfileSkeleton />
      </PageShell>
    );
  }

  const data = profile.data;
  if (profile.isError || !data) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
          <h1 className="text-lg font-bold">{t("profile.loadError")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(profile.error, t("common.error"))}</p>
          <Button variant="outline" className="mt-5 rounded-lg" onClick={() => void profile.refetch()}>
            <RefreshCw className={cn("h-4 w-4", profile.isFetching && "animate-spin")} />
            {t("common.retry")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const isMe = !!me && me.id === data.user.id;
  const totalMcapSol = data.createdCoins.reduce((sum, c) => sum + c.marketCapSol, 0);
  const totalVolumeSol = data.createdCoins.reduce((sum, c) => sum + c.volumeSol, 0);

  return (
    <PageShell>
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-2xl border border-border bg-card">
          <div className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl" aria-hidden />
          <div className="pointer-events-none absolute -right-16 -bottom-16 h-48 w-48 rounded-full bg-violet/10 blur-3xl" aria-hidden />
          <div className="relative flex flex-col items-center gap-4 p-6 text-center sm:flex-row sm:text-left">
            <PublicAvatar user={data.user} wallet={data.user.walletAddress ?? undefined} size={96} className="ring-4 ring-background shadow-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <h1 className="truncate text-2xl font-extrabold tracking-tight">@{data.user.username}</h1>
                {isMe && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-bold text-primary">{t("profile.you")}</span>
                )}
              </div>
              <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                {t("profile.joined", { date: format(new Date(data.joinedAt), "MMM d, yyyy") })}
              </p>
            </div>
            {isMe && (
              <Button asChild variant="outline" size="sm" className="rounded-lg">
                <Link href="/portfolio">
                  <Pencil className="h-4 w-4" />
                  {t("profile.editProfile")}
                </Link>
              </Button>
            )}
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile icon={<Coins className="h-4 w-4" />} label={t("profile.coins")} value={count(data.createdCoins.length)} />
          <StatTile icon={<PieChart className="h-4 w-4" />} label={t("profile.holdings")} value={count(data.holdingsCount)} />
          <StatTile icon={<ActivityIcon className="h-4 w-4" />} label={t("profile.createdMcap")} value={compactUsd(totalMcapSol * solUsd)} />
          <StatTile icon={<ActivityIcon className="h-4 w-4" />} label={t("profile.createdVolume")} value={compactUsd(totalVolumeSol * solUsd)} />
        </div>

        <section>
          <h2 className="mb-3 text-lg font-bold">{t("profile.coins")}</h2>
          {data.createdCoins.length === 0 ? (
            <EmptyBox icon={<Coins className="h-5 w-5" />}>{t("profile.noCoins", { username: data.user.username })}</EmptyBox>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {data.createdCoins.map((coin) => (
                <CoinCard key={coin.id} coin={coin} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-bold">{t("profile.recentTrades")}</h2>
          <RecentTrades userId={data.user.id} />
        </section>
      </div>
    </PageShell>
  );
}
