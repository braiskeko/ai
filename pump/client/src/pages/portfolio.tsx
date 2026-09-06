import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowRight,
  Briefcase,
  Camera,
  Check,
  Coins,
  Gift,
  History,
  Loader2,
  LogIn,
  Pencil,
  PieChart,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import type { Portfolio, PortfolioHolding, SafeUser } from "@shared/schema";
import { TOTAL_SUPPLY, updateProfileSchema } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard, CoinCardSkeleton } from "@/components/CoinCard";
import { PublicAvatar } from "@/components/TradesTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest } from "@/lib/queryClient";
import { compactUsd, priceSol, priceUsd, signedPct, signedUsd, sol, tokens as fmtTokens, usd, useSolUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const AVATAR_PX = 256;
const AVATAR_MAX_DATA_URL = 1_500_000;

// ---------------------------------------------------------------------------
// Helpers
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

/** Center-crops the picture to a square and resizes it to AVATAR_PX × AVATAR_PX (webp, jpeg fallback). */
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

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

function PnlText({ valueSol, solUsd, className }: { valueSol: number; solUsd: number; className?: string }) {
  const neutral = Math.abs(valueSol) < 1e-6;
  return (
    <span className={cn("tabular font-semibold", neutral ? "text-muted-foreground" : valueSol > 0 ? "text-up" : "text-down", className)}>
      {signedUsd(valueSol, solUsd)}
    </span>
  );
}

function SummaryTile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="surface p-4">
      <div className="label">{label}</div>
      <div className={cn("stat mt-1 text-xl", accent)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center px-6 py-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      {hint && <p className="mt-1 max-w-xs text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile card: avatar upload + username edit
// ---------------------------------------------------------------------------

function ProfileCard({ user }: { user: SafeUser }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(user.username);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setUsername(user.username);
  }, [user.username, editing]);

  const applyUser = (next: SafeUser) => {
    qc.setQueryData(["/api/me"], next);
    void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
  };

  const rename = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PATCH", "/api/me", { username: name });
      return (await res.json()) as SafeUser;
    },
    onSuccess: (next) => {
      applyUser(next);
      setEditing(false);
      toast({ title: t("portfolio.saved"), description: `@${next.username}` });
    },
    onError: (err) => toast({ variant: "destructive", title: t("portfolio.saveFailed"), description: apiErrorMessage(err, t("common.error")) }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const image = await resizeAvatar(file);
      setPreview(image);
      const res = await apiRequest("POST", "/api/me/avatar", { image });
      return (await res.json()) as SafeUser;
    },
    onSuccess: (next) => {
      applyUser(next);
      setPreview(null);
      toast({ title: t("portfolio.saved"), description: t("portfolio.avatarUpdated") });
    },
    onError: (err) => {
      setPreview(null);
      toast({ variant: "destructive", title: t("portfolio.saveFailed"), description: apiErrorMessage(err, t("common.error")) });
    },
  });

  const parsed = updateProfileSchema.safeParse({ username });
  const changed = username.trim() !== user.username;
  const canSave = parsed.success && changed && !rename.isPending;

  return (
    <section className="surface flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
      <div className="relative mx-auto shrink-0 sm:mx-0">
        {preview ? (
          <img src={preview} alt="" className="h-20 w-20 rounded-full object-cover opacity-70" />
        ) : (
          <PublicAvatar user={user} size={80} />
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={upload.isPending}
          aria-label={t("portfolio.avatar")}
          title={t("portfolio.avatar")}
          className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-60"
        >
          {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
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

      <div className="min-w-0 flex-1 text-center sm:text-left">
        {editing ? (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) rename.mutate(username.trim());
            }}
          >
            <div className="flex-1">
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">@</span>
                <Input
                  autoFocus
                  value={username}
                  maxLength={24}
                  onChange={(e) => setUsername(e.target.value.replace(/\s+/g, ""))}
                  className="rounded-lg pl-7"
                  aria-label={t("portfolio.usernameLabel")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <p className={cn("mt-1 text-xs", changed && !parsed.success ? "text-down" : "text-muted-foreground")}>
                {t("portfolio.usernameHint")}
              </p>
            </div>
            <div className="flex justify-center gap-2 sm:justify-start">
              <Button type="submit" size="sm" className="rounded-lg" disabled={!canSave}>
                {rename.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("common.save")}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="rounded-lg" onClick={() => setEditing(false)} disabled={rename.isPending}>
                <X className="h-4 w-4" />
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <h2 className="truncate text-xl font-extrabold tracking-tight">@{user.username}</h2>
              {user.isAdmin && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {t("nav.admin")}
                </span>
              )}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
                {t("portfolio.editUsername")}
              </button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {user.walletAddress ? <span className="font-mono text-xs">{user.walletAddress}</span> : user.email}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("profile.joined", { date: format(new Date(user.createdAt), "MMM d, yyyy") })}</p>
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap justify-center gap-2 sm:flex-col sm:items-end">
        <Button asChild variant="outline" size="sm" className="rounded-lg">
          <Link href={`/u/${encodeURIComponent(user.username)}`}>
            {t("portfolio.viewProfile")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="rounded-lg">
          <Link href="/wallet">
            {t("portfolio.manageWallet")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

function HoldingRow({ h, solUsd }: { h: PortfolioHolding; solUsd: number }) {
  const t = useT();
  const avgSol = h.tokens > 0 ? h.costBasisSol / h.tokens : 0;
  const pnlPct = h.costBasisSol > 0 ? h.unrealizedPnlSol / h.costBasisSol : 0;
  const share = h.tokens / TOTAL_SUPPLY;
  return (
    <li className="surface card-hover tap overflow-hidden">
      <Link href={`/${h.coin.ca}`} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4" aria-label={t("coin.openCoin", { name: h.coin.name })}>
        <img src={h.coin.imageUrl} alt="" loading="lazy" decoding="async" className="h-14 w-14 shrink-0 rounded-2xl bg-muted object-cover sm:h-16 sm:w-16" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span className="truncate font-bold">{h.coin.name}</span>
            <span className="text-xs font-semibold text-muted-foreground">${h.coin.ticker}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular">
            {fmtTokens(h.tokens)} {h.coin.ticker}
            {share > 0.0001 && <span> · {(share * 100).toFixed(2)}%</span>}
            <span> · {t("portfolio.avgPrice")} {priceUsd(avgSol * solUsd)}</span>
            <span> · {t("coin.price")} {priceUsd(h.coin.priceSol * solUsd)}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right sm:w-[340px]">
          <div>
            <div className="label">{t("portfolio.value")}</div>
            <div className="font-bold tabular">{usd(h.valueSol, solUsd)}</div>
          </div>
          <div>
            <div className="label">{t("portfolio.pnl")}</div>
            <div>
              <PnlText valueSol={h.unrealizedPnlSol} solUsd={solUsd} />
              <div className={cn("text-[11px] tabular", pnlPct >= 0 ? "text-up" : "text-down")}>{signedPct(pnlPct)}</div>
            </div>
          </div>
          <div>
            <div className="label">{t("coin.mcap")}</div>
            <div className="font-semibold tabular text-primary">{compactUsd(h.coin.marketCapSol * solUsd)}</div>
          </div>
        </div>
        <span className="hidden shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold sm:inline-flex">{t("portfolio.trade")}</span>
      </Link>
    </li>
  );
}

function HoldingsList({ holdings, solUsd }: { holdings: PortfolioHolding[]; solUsd: number }) {
  const t = useT();
  if (holdings.length === 0) {
    return (
      <EmptyState
        icon={<PieChart className="h-5 w-5" />}
        title={t("portfolio.empty")}
        hint={t("portfolio.emptyHint")}
        action={
          <Button asChild variant="outline" className="rounded-lg">
            <Link href="/">
              <Sparkles className="h-4 w-4" />
              {t("portfolio.exploreCoins")}
            </Link>
          </Button>
        }
      />
    );
  }
  const sorted = holdings.slice().sort((a, b) => b.valueSol - a.valueSol);
  return (
    <ul className="space-y-2">
      {sorted.map((h) => (
        <HoldingRow key={h.coinId} h={h} solUsd={solUsd} />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTable({ trades, solUsd }: { trades: Portfolio["trades"]; solUsd: number }) {
  const t = useT();
  if (trades.length === 0) {
    return <EmptyState icon={<History className="h-5 w-5" />} title={t("trades.empty")} hint={t("portfolio.emptyHistory")} />;
  }
  const rows = trades.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  return (
    <div className="surface overflow-hidden">
      {/* Mobile: stacked rows */}
      <ul className="feed-divide sm:hidden">
        {rows.map((tr) => {
          const buy = tr.side === "buy";
          return (
            <li key={tr.id} className="flex items-center gap-3 px-4 py-3">
              <img src={tr.coin.imageUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-xl bg-muted object-cover" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className={cn("inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide", buy ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                    {buy ? t("trade.buy") : t("trade.sell")}
                  </span>
                  <span className="truncate font-semibold">
                    {tr.coin.name} <span className="text-xs font-medium text-muted-foreground">${tr.coin.ticker}</span>
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs tabular text-muted-foreground">
                  {fmtTokens(tr.tokens)} {tr.coin.ticker} · {priceSol(tr.priceSol)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={cn("stat text-sm", buy ? "text-foreground" : "text-up")}>
                  {buy ? "-" : "+"}
                  {usd(tr.sol, solUsd)}
                </div>
                <div className="text-[11px] text-muted-foreground" title={new Date(tr.createdAt).toLocaleString()}>
                  {format(new Date(tr.createdAt), "MMM d, HH:mm")}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Table className="hidden min-w-[680px] sm:table">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("trades.time")}</TableHead>
            <TableHead>{t("portfolio.coin")}</TableHead>
            <TableHead>{t("trades.type")}</TableHead>
            <TableHead className="text-right">{t("trades.tokens")}</TableHead>
            <TableHead className="text-right">{t("trades.price")}</TableHead>
            <TableHead className="text-right">{t("trades.sol")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tr) => {
            const buy = tr.side === "buy";
            return (
              <TableRow key={tr.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular" title={new Date(tr.createdAt).toLocaleString()}>
                  {format(new Date(tr.createdAt), "MMM d, HH:mm")}
                </TableCell>
                <TableCell className="max-w-[260px]">
                  <Link href={`/${tr.coin.ca}`} className="flex items-center gap-2 hover:underline">
                    <img src={tr.coin.imageUrl} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-lg bg-muted object-cover" />
                    <span className="truncate text-sm font-medium">{tr.coin.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">${tr.coin.ticker}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className={cn("inline-flex rounded-md px-1.5 py-0.5 text-xs font-semibold", buy ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                    {buy ? t("trade.buy") : t("trade.sell")}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular">
                  {fmtTokens(tr.tokens)} <span className="text-muted-foreground">{tr.coin.ticker}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular text-muted-foreground">{priceSol(tr.priceSol)}</TableCell>
                <TableCell className={cn("whitespace-nowrap text-right font-medium tabular", buy ? "text-foreground" : "text-up")}>
                  {buy ? "-" : "+"}
                  {usd(tr.sol, solUsd)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PortfolioSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-[112px] rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-10 w-72 rounded-lg" />
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <CoinCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  const t = useT();
  const solUsd = useSolUsd();
  const { user, isLoading: authLoading, openLogin } = useAuth();

  const portfolio = useQuery<Portfolio>({
    queryKey: ["/api/portfolio"],
    enabled: !!user,
    staleTime: 15_000,
  });

  if (authLoading || (user && portfolio.isLoading)) {
    return (
      <PageShell>
        <PortfolioSkeleton />
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto flex w-full max-w-md flex-col items-center surface p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Briefcase className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">{t("portfolio.loginRequired")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("portfolio.loginHint")}</p>
          <Button className="mt-6 rounded-lg font-semibold" onClick={openLogin}>
            <LogIn className="h-4 w-4" />
            {t("nav.login")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const data = portfolio.data;
  if (portfolio.isError || !data) {
    return (
      <PageShell className="flex items-center justify-center">
        <div className="mx-auto w-full max-w-md surface p-8 text-center">
          <h1 className="text-lg font-bold">{t("portfolio.loadError")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(portfolio.error, t("common.error"))}</p>
          <Button variant="outline" className="mt-5 rounded-lg" onClick={() => void portfolio.refetch()}>
            <RefreshCw className={cn("h-4 w-4", portfolio.isFetching && "animate-spin")} />
            {t("common.retry")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const holdings = data.holdings.filter((h) => h.tokens > 1e-9);
  const totalPnlSol = data.realizedPnlSol + data.unrealizedPnlSol;

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{t("portfolio.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("portfolio.subtitle")}</p>
          </div>
        </div>

        <ProfileCard user={user} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SummaryTile label={t("portfolio.total")} value={usd(data.totalValueSol, solUsd)} sub={sol(data.totalValueSol)} />
          <SummaryTile label={t("portfolio.cash")} value={usd(data.balanceSol, solUsd)} sub={sol(data.balanceSol)} accent="text-primary" />
          <SummaryTile
            label={t("portfolio.holdings")}
            value={usd(data.holdingsValueSol, solUsd)}
            sub={t("portfolio.holdingsCount", { n: count(holdings.length) })}
          />
          <SummaryTile
            label={t("portfolio.pnl")}
            value={<PnlText valueSol={totalPnlSol} solUsd={solUsd} className="text-xl" />}
            sub={
              <span className="tabular">
                {t("portfolio.unrealized")} <PnlText valueSol={data.unrealizedPnlSol} solUsd={solUsd} className="font-medium" /> ·{" "}
                {t("portfolio.realized")} <PnlText valueSol={data.realizedPnlSol} solUsd={solUsd} className="font-medium" />
              </span>
            }
          />
          <SummaryTile
            label={t("portfolio.creatorEarnings")}
            value={usd(data.creatorClaimableSol, solUsd)}
            accent="text-gold"
            sub={data.creatorClaimableSol > 0 ? t("portfolio.creatorEarningsHint") : sol(data.creatorClaimableSol)}
          />
        </div>

        <Tabs defaultValue="holdings">
          <TabsList className="h-auto flex-wrap rounded-lg">
            <TabsTrigger value="holdings" className="rounded-md">
              <PieChart className="mr-1.5 h-3.5 w-3.5" />
              {t("portfolio.tab.holdings")}
              {holdings.length > 0 && <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{holdings.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="created" className="rounded-md">
              <Coins className="mr-1.5 h-3.5 w-3.5" />
              {t("portfolio.tab.created")}
              {data.createdCoins.length > 0 && (
                <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{data.createdCoins.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="rounded-md">
              <History className="mr-1.5 h-3.5 w-3.5" />
              {t("portfolio.tab.history")}
              {data.trades.length > 0 && <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{data.trades.length}</span>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="holdings" className="mt-4">
            <HoldingsList holdings={holdings} solUsd={solUsd} />
          </TabsContent>

          <TabsContent value="created" className="mt-4">
            {data.createdCoins.length === 0 ? (
              <EmptyState
                icon={<Coins className="h-5 w-5" />}
                title={t("portfolio.emptyCreated")}
                hint={t("header.earnHint")}
                action={
                  <Button asChild className="rounded-lg font-semibold">
                    <Link href="/create">
                      <Sparkles className="h-4 w-4" />
                      {t("nav.create")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.createdCoins.map((coin) => (
                  <CoinCard key={coin.id} coin={coin} />
                ))}
                {data.creatorClaimableSol > 0 && (
                  <div className="sm:col-span-2">
                    <div className="flex items-center gap-3 rounded-xl border border-gold/40 bg-gold/5 px-4 py-3 text-sm">
                      <Gift className="h-4 w-4 shrink-0 text-gold" />
                      <span className="text-muted-foreground">{t("portfolio.creatorEarningsHint")}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <HistoryTable trades={data.trades} solUsd={solUsd} />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}
