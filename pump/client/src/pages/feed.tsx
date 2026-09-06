import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Heart, Rss, Sliders } from "lucide-react";
import type { FeedEntry, FeedScope } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { PublicAvatar, TraderName } from "@/components/TradesTable";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/i18n";
import { useLiveEvent } from "@/lib/useLive";
import { compactUsd, timeAgo, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const FEED_LIMIT = 80;

/** Per-session, client-only like counter (there is no server-side reaction store for feed rows). */
function useLocalLikes() {
  const [likes, setLikes] = useState<Record<string, number>>({});
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const toggle = (key: string, seed: number) => {
    setLiked((prev) => {
      const next = new Set(prev);
      const isLiked = next.has(key);
      if (isLiked) next.delete(key);
      else next.add(key);
      setLikes((counts) => ({ ...counts, [key]: (counts[key] ?? seed) + (isLiked ? -1 : 1) }));
      return next;
    });
  };
  const countOf = (key: string, seed: number) => likes[key] ?? seed;
  const isLiked = (key: string) => liked.has(key);
  return { toggle, countOf, isLiked };
}

/** Small, stable pseudo-count so rows don't all read "0 likes" (seeded by the item's key). */
function seedLikes(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 23;
}

function FeedRow({ item, isNew, solUsd }: { item: FeedEntry; isNew: boolean; solUsd: number }) {
  const t = useT();
  const { user: me } = useAuth();
  const likes = useLocalLikesContext();
  const mine = !!me?.walletAddress && me.walletAddress === item.wallet;
  const profileHref = item.user ? `/${encodeURIComponent(item.user.username)}` : null;
  const seed = seedLikes(item.key);
  const count = likes.countOf(item.key, seed);
  const active = likes.isLiked(item.key);

  const tagTone =
    item.kind === "created"
      ? "bg-violet/15 text-violet"
      : item.kind === "thesis"
        ? "bg-primary/15 text-primary"
        : item.side === "buy"
          ? "bg-up/15 text-up"
          : "bg-down/15 text-down";
  const tagLabel =
    item.kind === "created"
      ? t("feed.launched")
      : item.kind === "thesis"
        ? t("thesis.badge")
        : item.side === "buy"
          ? t("trade.buy")
          : t("trade.sell");
  const amount = item.kind === "created" || item.kind === "thesis" ? null : compactUsd((item.sol ?? 0) * solUsd);
  const mcap = compactUsd((item.marketCapSol ?? 0) * solUsd);

  return (
    <motion.li
      layout="position"
      initial={isNew ? { opacity: 0, y: -16, backgroundColor: "hsl(var(--primary) / 0.12)" } : false}
      animate={{ opacity: 1, y: 0, backgroundColor: "hsl(var(--primary) / 0)" }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className="px-4 py-3"
    >
      <div className="flex items-center gap-2">
        {profileHref ? (
          <Link href={profileHref} className="shrink-0">
            <PublicAvatar user={item.user} wallet={item.wallet} size={32} />
          </Link>
        ) : (
          <PublicAvatar user={null} wallet={item.wallet} size={32} />
        )}
        <span className="min-w-0 truncate text-sm font-bold">
          {profileHref ? (
            <Link href={profileHref} className="hover:underline">
              <TraderName user={item.user} wallet={item.wallet} mine={mine} />
            </Link>
          ) : (
            <TraderName user={null} wallet={item.wallet} mine={mine} />
          )}
        </span>
        <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold", tagTone)}>{tagLabel}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={new Date(item.at).toLocaleString()}>
          {timeAgo(item.at)}
        </span>
      </div>

      {/* Indented line joined to the avatar above by a thin L-shaped connector. */}
      <div className="ml-4 mt-1.5 flex gap-3 border-l border-dotted border-border pl-4">
        <Link href={`/${item.coin.ca}`} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 hover:underline">
          <img src={item.coin.imageUrl} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded-md bg-muted object-cover" />
          <span className="shrink-0 text-sm font-bold uppercase">{item.coin.ticker}</span>
          {amount ? (
            <span className="truncate text-sm text-muted-foreground">
              {amount} <span className="text-xs">{t("feed.at")}</span> {mcap} {t("feed.mc")}
            </span>
          ) : (
            <span className="truncate text-sm text-muted-foreground">{mcap} {t("feed.mc")}</span>
          )}
        </Link>
      </div>

      {item.kind === "thesis" && item.body && (
        <p className="ml-4 mt-1 whitespace-pre-wrap break-words border-l border-dotted border-border pl-4 text-sm leading-relaxed">
          {item.body}
        </p>
      )}

      <div className="ml-4 mt-1.5 pl-4">
        <button
          type="button"
          onClick={() => likes.toggle(item.key, seed)}
          aria-pressed={active}
          className={cn(
            "tap inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground",
            active && "text-down hover:text-down",
          )}
        >
          <Heart className={cn("h-3.5 w-3.5", active && "fill-current")} />
          <span className="tabular">{count}</span>
        </button>
      </div>
    </motion.li>
  );
}

// A single shared like-store instance for the page, so every row reads/writes the same counters.
const LocalLikesContext = createContext<ReturnType<typeof useLocalLikes> | null>(null);
function useLocalLikesContext() {
  const ctx = useContext(LocalLikesContext);
  if (!ctx) throw new Error("useLocalLikesContext must be used inside <LocalLikesContext.Provider>");
  return ctx;
}

function FeedSkeleton() {
  return (
    <ul className="surface feed-divide overflow-hidden" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 p-4">
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The activity list itself — every buy, sell, launch and thesis in `scope`, newest
 * first. Exported so the People screen can show the same thing under "Following".
 */
export function ActivityFeed({ scope }: { scope: FeedScope }) {
  const t = useT();
  const solUsd = useSolUsd();
  const { user } = useAuth();
  const likesStore = useLocalLikes();

  const feedKey = `/api/feed?scope=${scope}&limit=${FEED_LIMIT}`;
  const feed = useQuery<FeedEntry[]>({ queryKey: [feedKey], staleTime: 10_000 });
  useLiveEvent("trade", () => void feed.refetch());
  useLiveEvent("coin:created", () => void feed.refetch());

  const items = feed.data ?? [];
  const seenRef = useRef<Set<string> | null>(null);
  const isNewSet = useMemo(() => {
    const seen = seenRef.current;
    if (!seen) return new Set<string>();
    return new Set(items.filter((i) => !seen.has(i.key)).map((i) => i.key));
  }, [items]);
  useEffect(() => {
    if (feed.isLoading) return;
    seenRef.current = new Set(items.map((i) => i.key));
    // Only the identities matter across renders, not the list contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, feed.isLoading]);

  if (feed.isLoading) return <FeedSkeleton />;
  if (scope === "following" && !user) {
    return (
      <div className="surface flex flex-col items-center px-6 py-16 text-center">
        <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Rss className="h-5 w-5" />
        </div>
        <h3 className="font-semibold">{t("feed.followingLoginTitle")}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("feed.followingLoginHint")}</p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="surface flex flex-col items-center px-6 py-16 text-center">
        <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Rss className="h-5 w-5" />
        </div>
        <h3 className="font-semibold">{scope === "following" ? t("feed.emptyFollowing") : t("activity.empty")}</h3>
        {scope === "following" && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("feed.emptyFollowingHint")}</p>}
      </div>
    );
  }
  return (
    <LocalLikesContext.Provider value={likesStore}>
      <ul className="surface feed-divide overflow-hidden">
        {items.map((item) => (
          <FeedRow key={item.key} item={item} isNew={isNewSet.has(item.key)} solUsd={solUsd} />
        ))}
      </ul>
    </LocalLikesContext.Provider>
  );
}

export default function FeedPage() {
  const t = useT();
  const solUsd = useSolUsd();
  const { user } = useAuth();
  const [scope, setScope] = useState<FeedScope>("global");
  const likesStore = useLocalLikes();

  useEffect(() => {
    document.title = `${t("feed.title")} · ${t("app.name")}`;
  }, [t]);

  const feedKey = `/api/feed?scope=${scope}&limit=${FEED_LIMIT}`;
  const feed = useQuery<FeedEntry[]>({ queryKey: [feedKey], staleTime: 10_000 });

  useLiveEvent("trade", () => void feed.refetch());
  useLiveEvent("coin:created", () => void feed.refetch());

  const items = feed.data ?? [];

  // Rows present the first time this scope loads never animate; anything that shows up
  // afterwards (a live trade/launch, brought in by the refetch above) slides in fresh.
  const seenRef = useRef<Map<FeedScope, Set<string>>>(new Map());
  const isNewSet = useMemo(() => {
    const seen = seenRef.current.get(scope);
    if (!seen) return new Set<string>();
    return new Set(items.filter((i) => !seen.has(i.key)).map((i) => i.key));
  }, [items, scope]);
  useEffect(() => {
    if (feed.isLoading) return;
    seenRef.current.set(scope, new Set(items.map((i) => i.key)));
    // Only the item identities need tracking across renders, not the full list contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, scope, feed.isLoading]);

  return (
    <PageShell>
      <LocalLikesContext.Provider value={likesStore}>
        <div className="mx-auto max-w-2xl">
          <div className="mb-4 flex items-center border-b border-border">
            {(["global", "following"] as FeedScope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn(
                  "relative -mb-px flex-1 border-b-2 py-3 text-center text-base font-bold transition-colors",
                  scope === s ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
                )}
              >
                {s === "global" ? t("feed.global") : t("feed.following")}
              </button>
            ))}
            <span className="grid h-9 w-9 shrink-0 place-items-center text-muted-foreground" aria-hidden>
              <Sliders className="h-4 w-4" />
            </span>
          </div>

          {feed.isLoading ? (
            <FeedSkeleton />
          ) : scope === "following" && !user?.walletAddress ? (
            <div className="surface flex flex-col items-center px-6 py-16 text-center">
              <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Rss className="h-5 w-5" />
              </div>
              <h3 className="font-semibold">{t("feed.followingLoginTitle")}</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("feed.followingLoginHint")}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="surface flex flex-col items-center px-6 py-16 text-center">
              <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Rss className="h-5 w-5" />
              </div>
              <h3 className="font-semibold">{scope === "following" ? t("feed.emptyFollowing") : t("activity.empty")}</h3>
              {scope === "following" && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("feed.emptyFollowingHint")}</p>}
            </div>
          ) : (
            <ul className="surface feed-divide overflow-hidden">
              {items.map((item) => (
                <FeedRow key={item.key} item={item} isNew={isNewSet.has(item.key)} solUsd={solUsd} />
              ))}
            </ul>
          )}
        </div>
      </LocalLikesContext.Provider>
    </PageShell>
  );
}
