import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Activity as ActivityIcon,
  CalendarDays,
  Clock,
  Coins,
  History,
  DollarSign,
  Loader2,
  MoreHorizontal,
  Pencil,
  PieChart,
  Plus,
  Repeat,
  Settings,
} from "lucide-react";
import type { Portfolio, PublicProfile, SafeUser } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard, CoinCardSkeleton } from "@/components/CoinCard";
import { useDepositSheet } from "@/components/DepositSheet";
import { EmptyBox, PublicAvatar } from "@/components/TradesTable";
import { FollowButton } from "@/components/TraderCard";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useLiveTrades } from "@/lib/useLive";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { compactUsd, priceSol, timeAgo, tokens as fmtTokens, usd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/not-found";

type Range = "24h" | "7d" | "30d" | "all";
const RANGES: Range[] = ["24h", "7d", "30d", "all"];
const RANGE_MS: Record<Range, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: 0 };
const AVATAR_PX = 256;
const AVATAR_MAX_DATA_URL = 1_500_000;
const RECENT_TRADES = 30;

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

/** "Aug 2026", or "—" when the stored timestamp is missing or unparseable (date-fns throws on those). */
function joinedLabel(iso: string | null | undefined): string {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? format(new Date(ms), "MMM yyyy") : "—";
}

/** "4h 48m" / "32m" — average time between a position's first and last trade. */
function formatHold(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Avatar upload (isMe only) — same encode/resize as portfolio.tsx's ProfileCard
// ---------------------------------------------------------------------------

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}
async function resizeAvatar(file: File): Promise<string> {
  const img = await loadImage(await readAsDataUrl(file));
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const side = Math.min(w, h);
  const sx = Math.floor((w - side) / 2);
  const sy = Math.floor((h - side) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  const encode = (quality: number) => {
    const webp = canvas.toDataURL("image/webp", quality);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
  };
  let out = encode(0.9);
  if (out.length > AVATAR_MAX_DATA_URL) out = encode(0.7);
  return out;
}

function EditableAvatar({ user }: { user: SafeUser }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const image = await resizeAvatar(file);
      setPreview(image);
      const res = await apiRequest("POST", "/api/me/avatar", { image });
      return (await res.json()) as SafeUser;
    },
    onSuccess: (next) => {
      qc.setQueryData(["/api/me"], next);
      void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/users/") });
      setPreview(null);
    },
    onError: (err) => {
      setPreview(null);
      toast({ variant: "destructive", title: t("portfolio.saveFailed"), description: apiErrorMessage(err, t("common.error")) });
    },
  });

  return (
    <div className="relative shrink-0">
      {preview ? (
        <img src={preview} alt="" className="h-24 w-24 rounded-full object-cover opacity-70" />
      ) : (
        <PublicAvatar user={user} size={96} className="ring-4 ring-background shadow-lg" />
      )}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={upload.isPending}
        aria-label={t("portfolio.avatar")}
        title={t("portfolio.avatar")}
        className="absolute bottom-0 right-0 grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-foreground text-background shadow-md disabled:opacity-60"
      >
        {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload.mutate(file);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equity curve — cumulative realised PnL replayed from the public trade list
// ---------------------------------------------------------------------------

function buildEquityCurve(trades: PublicProfile["trades"], rangeMs: number): number[] {
  const cutoff = rangeMs > 0 ? Date.now() - rangeMs : 0;
  const chronological = trades
    .filter((tr) => Date.parse(tr.createdAt) >= cutoff)
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);

  const perCoin = new Map<number, { tokens: number; costBasisSol: number }>();
  const points: number[] = [0];
  let cumulative = 0;
  for (const tr of chronological) {
    let st = perCoin.get(tr.coinId);
    if (!st) {
      st = { tokens: 0, costBasisSol: 0 };
      perCoin.set(tr.coinId, st);
    }
    if (tr.side === "buy") {
      st.tokens += tr.tokens;
      st.costBasisSol += tr.sol;
    } else {
      const fraction = st.tokens > 0 ? Math.min(1, tr.tokens / st.tokens) : 1;
      const costOfSold = st.costBasisSol * fraction;
      cumulative += tr.sol - costOfSold;
      st.costBasisSol = Math.max(0, st.costBasisSol - costOfSold);
      st.tokens = Math.max(0, st.tokens - tr.tokens);
    }
    points.push(cumulative);
  }
  return points;
}

function EquityChart({ points }: { points: number[] }) {
  const width = 320;
  const height = 96;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((p, i) => [i * step, height - ((p - min) / span) * height] as const);
  const up = (points[points.length - 1] ?? 0) >= (points[0] ?? 0);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `M0,${height} L${line} L${width},${height} Z`;
  const stroke = up ? "hsl(var(--up))" : "hsl(var(--down))";

  if (points.length <= 1) {
    return <div className="grid h-24 place-items-center text-xs text-muted-foreground">—</div>;
  }
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={areaPath} fill={stroke} opacity={0.12} />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r={4} fill={stroke} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Recent trades (own trades, merged with the live socket)
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

function RecentTrades({ userId, history }: { userId: number; history: PublicProfile["trades"] }) {
  const t = useT();
  const solUsd = useSolUsd();
  const live = useLiveTrades(200);

  const trades = useMemo<UserTrade[]>(() => {
    const byId = new Map<number, UserTrade>();
    for (const { coin, trade } of live) {
      if (trade.userId !== userId) continue;
      byId.set(trade.id, { id: trade.id, at: trade.createdAt, side: trade.side, sol: trade.sol, tokens: trade.tokens, priceSol: trade.priceSol, coin });
    }
    for (const tr of history) {
      if (byId.has(tr.id)) continue;
      byId.set(tr.id, { id: tr.id, at: tr.createdAt, side: tr.side, sol: tr.sol, tokens: tr.tokens, priceSol: tr.priceSol, coin: tr.coin });
    }
    return Array.from(byId.values())
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id)
      .slice(0, RECENT_TRADES);
  }, [live, history, userId]);

  if (trades.length === 0) {
    return <EmptyBox icon={<ActivityIcon className="h-5 w-5" />}>{t("profile.noTrades")}</EmptyBox>;
  }
  return (
    <ul className="surface feed-divide overflow-hidden">
      {trades.map((tr) => {
        const buy = tr.side === "buy";
        return (
          <li key={tr.id} className="flex items-center gap-3 p-3 transition-colors hover:bg-accent/40">
            <span className={cn("inline-flex w-12 shrink-0 justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold", buy ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
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
// Positions (isMe only — needs the private wallet-backed portfolio)
// ---------------------------------------------------------------------------

function MyPositions() {
  const t = useT();
  const solUsd = useSolUsd();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const portfolio = useQuery<Portfolio>({ queryKey: ["/api/portfolio"], staleTime: 15_000 });

  if (portfolio.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-2xl" />
        ))}
      </div>
    );
  }
  const data = portfolio.data;
  const open = (data?.holdings ?? []).filter((h) => h.tokens > 1e-9);
  const closedCoinIds = new Set(
    (data?.trades ?? []).map((tr) => tr.coin.id).filter((id) => !open.some((h) => h.coin.id === id)),
  );
  const closed = Array.from(closedCoinIds)
    .map((id) => data?.trades.find((tr) => tr.coin.id === id)?.coin)
    .filter((c): c is NonNullable<typeof c> => !!c);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">{t("profile.positions")}</h2>
        <div className="inline-flex rounded-full border border-border bg-card p-1">
          {(["open", "closed"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                "h-8 rounded-full px-3 text-xs font-bold transition-colors",
                tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {k === "open" ? t("profile.open") : t("profile.closed")}
            </button>
          ))}
        </div>
      </div>
      {tab === "open" ? (
        open.length === 0 ? (
          <EmptyBox icon={<PieChart className="h-5 w-5" />}>{t("profile.noOpenPositions")}</EmptyBox>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {open.map((h) => (
              <Link
                key={h.coinId}
                href={`/${h.coin.ca}`}
                className="surface card-hover flex items-center gap-3 p-3"
              >
                <img src={h.coin.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-2xl bg-muted object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{h.coin.name}</div>
                  <div className="truncate text-xs text-muted-foreground tabular">{fmtTokens(h.tokens)} {h.coin.ticker}</div>
                </div>
                <div className={cn("shrink-0 text-sm font-bold tabular", h.unrealizedPnlSol >= 0 ? "text-up" : "text-down")}>
                  {h.unrealizedPnlSol >= 0 ? "+" : "-"}
                  {compactUsd(Math.abs(h.unrealizedPnlSol) * solUsd)}
                </div>
              </Link>
            ))}
          </div>
        )
      ) : closed.length === 0 ? (
        <EmptyBox icon={<PieChart className="h-5 w-5" />}>{t("profile.noClosedPositions")}</EmptyBox>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {closed.map((c) => (
            <Link key={c.id} href={`/${c.ca}`} className="surface card-hover flex items-center gap-3 p-3">
              <img src={c.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-2xl bg-muted object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{c.name}</div>
                <div className="truncate text-xs text-muted-foreground">${c.ticker}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ProfileSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="flex flex-col items-center gap-4 surface p-6 sm:flex-row">
        <Skeleton className="h-24 w-24 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <CoinCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export default function ProfilePage({ username: explicit }: { username?: string } = {}) {
  const t = useT();
  const solUsd = useSolUsd();
  const params = useParams<{ username: string }>();
  const username = explicit ?? decodeURIComponent(params.username ?? "");
  const { user: me } = useAuth();
  const [range, setRange] = useState<Range>("24h");
  const [historyOpen, setHistoryOpen] = useState(false);

  const profile = useQuery<PublicProfile>({
    queryKey: [`/api/users/${encodeURIComponent(username)}`],
    enabled: username.length > 0,
    staleTime: 30_000,
  });

  // Your own profile is never "not found": if the lookup fails while the session
  // still knows who you are, the session is what went stale — re-read it and show
  // the page from what we already have rather than a dead end.
  const looksMissing = profile.isError && isNotFound(profile.error);
  const isSelfLookup = !!me && me.username.toLowerCase() === username.toLowerCase();
  if (looksMissing && isSelfLookup) {
    void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
  }
  if (!username || (looksMissing && !isSelfLookup)) {
    return <NotFound title={t("profile.notFound")} hint={t("profile.notFoundHint", { app: t("app.name"), username })} />;
  }

  if (profile.isLoading) {
    return (
      <PageShell>
        <ProfileSkeleton />
      </PageShell>
    );
  }

  // Fall back to the session's own view of the account when the public lookup fails.
  const data: PublicProfile | undefined =
    profile.data ??
    (isSelfLookup && me
      ? {
          user: {
            id: me.id,
            username: me.username,
            displayName: me.displayName ?? null,
            bio: me.bio ?? null,
            avatarSeed: me.avatarSeed,
            avatarUrl: me.avatarUrl,
            bannerUrl: me.bannerUrl ?? null,
            walletAddress: me.walletAddress,
          },
          createdCoins: [],
          trades: [],
          joinedAt: me.createdAt,
          holdingsCount: 0,
          followers: 0,
          following: 0,
          isFollowing: false,
          volumeSol: 0,
          tradeCount: 0,
          avgHoldMinutes: 0,
          pnlSol: 0,
        }
      : undefined);
  if (!data) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto w-full max-w-md surface p-8 text-center">
          <h1 className="text-lg font-bold">{t("profile.loadError")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(profile.error, t("common.error"))}</p>
        </div>
      </PageShell>
    );
  }

  const isMe = !!me && me.id === data.user.id;
  const points = buildEquityCurve(data.trades, RANGE_MS[range]);
  const rangeValueSol = points[points.length - 1] ?? 0;

  return (
    <PageShell noHeader className="pt-4">
      <div className="space-y-6">
        <section className="surface relative overflow-hidden p-5">
          {/* History sits to the left of settings, the way the design has it. */}
          <div className="absolute right-4 top-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label={t("profile.history")}
              className="tap grid h-10 w-10 place-items-center rounded-full bg-muted/60 text-foreground"
            >
              <History className="h-[18px] w-[18px]" />
            </button>
            {isMe ? (
              <Link
                href="/settings"
                aria-label={t("settings.title")}
                className="tap grid h-10 w-10 place-items-center rounded-full bg-muted/60 text-foreground"
              >
                <Settings className="h-[18px] w-[18px]" />
              </Link>
            ) : (
              data.user.walletAddress && <FollowButton wallet={data.user.walletAddress} isFollowing={data.isFollowing} />
            )}
          </div>

          <div className="flex items-start gap-4">
            {isMe ? <EditableAvatar user={me!} /> : <PublicAvatar user={data.user} size={96} className="ring-4 ring-background shadow-lg" />}
            <div className="min-w-0 flex-1 pt-1">
              <h1 className="truncate text-xl font-extrabold tracking-tight">{data.user.displayName || data.user.username}</h1>
              <p className="truncate text-sm text-muted-foreground">@{data.user.username}</p>
              {data.user.bio && <p className="mt-1.5 whitespace-pre-wrap break-words text-[15px]">{data.user.bio}</p>}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
            <span className="tabular"><b className="font-extrabold">{compact(data.following)}</b> <span className="text-muted-foreground">{t("profile.following")}</span></span>
            <span className="tabular"><b className="font-extrabold">{compact(data.followers)}</b> <span className="text-muted-foreground">{t("profile.followers")}</span></span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{t("profile.avgHold", { time: formatHold(data.avgHoldMinutes) })}</span>
            <span className="inline-flex items-center gap-1"><Repeat className="h-3.5 w-3.5" />{t("profile.tradeCount", { n: count(data.tradeCount) })}</span>
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{t("profile.joined", { date: joinedLabel(data.joinedAt) })}</span>
          </div>
        </section>

        <section className="surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={cn("stat text-3xl", rangeValueSol >= 0 ? "text-up" : "text-down")}>
                {rangeValueSol >= 0 ? "+" : "-"}
                {compactUsd(Math.abs(rangeValueSol) * solUsd)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("profile.pnlOver", { range: t(`people.range.${range}`) })}</div>
            </div>
            <div className="inline-flex shrink-0 rounded-full border border-border bg-card p-1">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "h-8 rounded-full px-2.5 text-xs font-bold transition-colors",
                    range === r ? "bg-foreground text-background" : "text-muted-foreground",
                  )}
                >
                  {t(`people.range.${r}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <EquityChart points={points} />
          </div>

          {isMe ? (
            <MyCash />
          ) : (
            <div className="mt-4 flex items-center gap-3 border-t border-border/70 pt-4">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-muted text-muted-foreground">
                <Coins className="h-4 w-4" />
              </span>
              <div>
                <div className="text-xs text-muted-foreground">{t("profile.pnlAllTime")}</div>
                <div className={cn("font-bold tabular", data.pnlSol >= 0 ? "text-up" : "text-down")}>
                  {data.pnlSol >= 0 ? "+" : "-"}
                  {compactUsd(Math.abs(data.pnlSol) * solUsd)}
                </div>
              </div>
            </div>
          )}
        </section>

        {isMe ? (
          <MyPositions />
        ) : (
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
        )}

      </div>

      {/* The movement list lives behind the history button rather than under the positions. */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-y-auto rounded-t-[28px] border-t-0 bg-secondary/95 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl"
        >
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" aria-hidden />
          <SheetTitle className="text-center text-[22px] font-bold">{t("profile.history")}</SheetTitle>
          <p className="mb-4 text-center text-sm text-muted-foreground">{t("profile.historyHint")}</p>
          <RecentTrades userId={data.user.id} history={data.trades} />
        </SheetContent>
      </Sheet>
    </PageShell>
  );
}

/**
 * The signed-in wallet's cash balance — private, so only ever shown on your own
 * profile. The square "+" beside it is the deposit entry point.
 */
function MyCash() {
  const t = useT();
  const solUsd = useSolUsd();
  const deposit = useDepositSheet();
  const wallet = useQuery<{ balanceSol: number }>({ queryKey: ["/api/wallet"], staleTime: 15_000 });
  return (
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/70 pt-4">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <DollarSign className="h-5 w-5" />
        </span>
        <div>
          <div className="text-[15px] text-muted-foreground">{t("profile.totalCash")}</div>
          <div className="text-[19px] font-bold tabular leading-tight">{usd(wallet.data?.balanceSol ?? 0, solUsd)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={deposit.open}
          aria-label={t("home.deposit")}
          className="tap grid h-12 w-12 place-items-center rounded-2xl bg-card text-foreground"
        >
          <Plus className="h-5 w-5" />
        </button>
        <Link
          href="/wallet"
          aria-label={t("nav.wallet")}
          className="tap grid h-12 w-12 place-items-center rounded-2xl bg-card text-foreground"
        >
          <MoreHorizontal className="h-5 w-5" />
        </Link>
      </div>
      {deposit.sheet}
    </div>
  );
}
