import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, RefreshCw } from "lucide-react";
import type { ActivityItem } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { UserAvatar } from "@/components/UserAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cents, shares, timeAgo, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Activity() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<ActivityItem[]>({
    queryKey: ["/api/activity?limit=60"],
    refetchInterval: 15_000,
  });

  return (
    <PageShell className="pb-16">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Activity</h1>
            <p className="mt-1 text-sm text-muted-foreground">Every trade across Foresight, as it happens.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yes opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-yes" />
            </span>
            Live
            <button
              onClick={() => refetch()}
              aria-label="Refresh"
              className="ml-1 grid h-7 w-7 place-items-center rounded-md border border-border bg-card hover:bg-accent"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </button>
          </div>
        </header>

        {isLoading ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border p-4 last:border-b-0">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <Empty title="Couldn't load activity" body="Please try again in a moment." />
        ) : !data || data.length === 0 ? (
          <Empty title="No trades yet" body="Once people start trading, their activity will show up here." />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            {data.map((item) => (
              <ActivityRow key={item.trade.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const { trade, user, market } = item;
  const outcome = market.outcomes[trade.outcomeId];
  const outcomeName = outcome?.name ?? `Outcome ${trade.outcomeId + 1}`;
  const outcomeClass = market.binary ? (trade.outcomeId === 0 ? "text-yes" : "text-no") : undefined;
  const outcomeStyle = market.binary ? undefined : { color: outcome?.color };
  const buy = trade.side === "buy";

  return (
    <li className="flex items-start gap-3 border-b border-border p-4 transition-colors last:border-b-0 hover:bg-accent/40 sm:items-center">
      <UserAvatar seed={user.avatarSeed} name={user.username} size={36} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">
          <span className="font-semibold">{user.username}</span>{" "}
          <span className={cn("font-medium", buy ? "text-foreground" : "text-muted-foreground")}>
            {buy ? "bought" : "sold"}
          </span>{" "}
          <span className="tabular">{shares(trade.shares)}</span>{" "}
          <span className={cn("font-semibold", outcomeClass)} style={outcomeStyle}>
            {outcomeName}
          </span>{" "}
          <span className="text-muted-foreground">at</span>{" "}
          <span className="tabular font-medium">{cents(trade.avgPrice)}</span>
        </p>
        <Link
          href={`/market/${market.slug}`}
          className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted text-xs leading-none">
            {market.imageEmoji}
          </span>
          <span className="truncate">{market.question}</span>
        </Link>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn("tabular text-sm font-semibold", buy ? "text-foreground" : "text-muted-foreground")}>
          {usd(trade.amount)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(trade.createdAt)}</div>
      </div>
    </li>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <ActivityIcon className="h-5 w-5" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
