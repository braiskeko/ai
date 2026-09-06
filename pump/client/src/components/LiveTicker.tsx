import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { ActivityItem, PublicUser, Trade } from "@shared/schema";
import { useLiveTrades } from "@/lib/useLive";
import { useT } from "@/i18n";
import { compactUsd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/UserAvatar";
import { LiveDot } from "@/components/Footer";

interface TickerItem {
  id: number;
  side: Trade["side"];
  sol: number;
  wallet: string;
  user: PublicUser | null;
  coin: { ca: string; ticker: string; name: string; imageUrl: string };
}

const ACTIVITY_KEY = "/api/activity?limit=60";

/**
 * Horizontal marquee of the latest trades ("@user bought $12 of CAT"), seeded
 * from /api/activity and updated live over the socket.
 */
export function LiveTicker({ limit = 30, className }: { limit?: number; className?: string }) {
  const t = useT();
  const solUsd = useSolUsd();
  const live = useLiveTrades(limit);
  const { data: activity } = useQuery<ActivityItem[]>({ queryKey: [ACTIVITY_KEY], staleTime: 30_000 });

  const items = useMemo<TickerItem[]>(() => {
    const seen = new Set<number>();
    const out: TickerItem[] = [];
    for (const { coin, trade } of live) {
      if (seen.has(trade.id)) continue;
      seen.add(trade.id);
      out.push({
        id: trade.id,
        side: trade.side,
        sol: trade.sol,
        wallet: trade.wallet,
        user: trade.user,
        coin: { ca: coin.ca, ticker: coin.ticker, name: coin.name, imageUrl: coin.imageUrl },
      });
    }
    for (const a of activity ?? []) {
      if (seen.has(a.trade.id)) continue;
      seen.add(a.trade.id);
      out.push({ id: a.trade.id, side: a.trade.side, sol: a.trade.sol, wallet: a.trade.wallet, user: a.user, coin: a.coin });
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }, [live, activity, limit]);

  if (items.length === 0) return null;

  // Duplicate the row so the CSS translateX(-50%) loop is seamless.
  const loop = [...items, ...items];
  const duration = Math.max(20, Math.min(120, items.length * 4));

  return (
    <div
      className={cn(
        "marquee relative flex items-center overflow-hidden rounded-xl border border-border bg-card/60",
        className,
      )}
      aria-live="off"
    >
      <div className="z-10 flex h-full shrink-0 items-center gap-2 border-r border-border bg-card px-3 py-2">
        <LiveDot />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden py-1.5 [mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]">
        <div className="marquee-track gap-2 pl-2" style={{ "--marquee-duration": `${duration}s` } as React.CSSProperties}>
          {loop.map((item, i) => {
            const buy = item.side === "buy";
            const handle = item.user ? `@${item.user.username}` : item.wallet.slice(0, 4) + "…" + item.wallet.slice(-4);
            return (
              <Link
                key={`${item.id}-${i}`}
                href={`/${item.coin.ca}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                  buy ? "border-primary/25 bg-primary/5" : "border-destructive/25 bg-destructive/5",
                )}
              >
                {item.user?.avatarUrl ? (
                  <img src={item.user.avatarUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                ) : (
                  <UserAvatar seed={item.user?.avatarSeed ?? item.wallet} name={item.user?.username ?? item.wallet} size={16} />
                )}
                <span className="whitespace-nowrap">
                  <span className="font-semibold">{handle}</span>{" "}
                  <span className={buy ? "text-primary" : "text-destructive"}>
                    {t(buy ? "home.feed.bought" : "home.feed.sold", {
                      user: "",
                      amount: compactUsd(item.sol * solUsd),
                      ticker: item.coin.ticker,
                    }).trim()}
                  </span>
                </span>
                <img src={item.coin.imageUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
