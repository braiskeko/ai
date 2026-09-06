import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Coins,
  Gauge,
  Loader2,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { AdminOverview, UnsignedTx, User } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { useWalletTx } from "@/lib/solana";
import { apiRequest } from "@/lib/queryClient";
import { compactUsd, dateShort, shortCa, sol, timeAgo, usd, useSolUsd } from "@/lib/format";
import NotFound from "@/pages/not-found";

const count = (n: number) => new Intl.NumberFormat("en-US").format(n);

function ListSkeleton({ rows = 3, height = 40 }: { rows?: number; height?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="rounded-xl" style={{ height }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Platform stats
// ---------------------------------------------------------------------------

function StatsStrip({ overview }: { overview: AdminOverview | undefined }) {
  const t = useT();
  const solUsd = useSolUsd();
  const data = overview?.stats;
  const tiles: { key: string; icon: LucideIcon; value: string | null }[] = [
    { key: "home.stats.coins", icon: Coins, value: data ? count(data.coins) : null },
    { key: "home.stats.volume", icon: TrendingUp, value: data ? compactUsd(data.volumeSol * solUsd) : null },
    { key: "home.stats.traders", icon: Users, value: data ? count(data.traders) : null },
    { key: "home.stats.trades", icon: Activity, value: data ? count(data.trades) : null },
    { key: "coin.graduated", icon: Sparkles, value: data ? count(data.graduated) : null },
    { key: "admin.vanityAvailable", icon: Sparkles, value: overview ? count(overview.vanityAvailable) : null },
  ];
  return (
    <section>
      <h2 className="mb-2 text-sm font-bold">{t("admin.stats")}</h2>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {tiles.map(({ key, icon: Icon, value }) => (
          <div key={key} className="flex items-center gap-3 surface px-3 py-2.5 sm:px-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate label">{t(key)}</div>
              {value === null ? <Skeleton className="mt-1 h-5 w-16" /> : <div className="truncate text-lg font-bold leading-tight tabular">{value}</div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Indexer status
// ---------------------------------------------------------------------------

function IndexerCard({ overview }: { overview: AdminOverview | undefined }) {
  const t = useT();
  const indexer = overview?.indexer;
  return (
    <section className="surface p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <Gauge className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("admin.indexer")}</h2>
      </div>
      {!indexer ? (
        <ListSkeleton rows={1} height={64} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <div className="label">{t("admin.rpcStatus")}</div>
            <div className={`mt-1 inline-flex items-center gap-1 text-sm font-semibold ${indexer.rpcOk ? "text-up" : "text-down"}`}>
              {indexer.rpcOk ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {indexer.rpcOk ? t("admin.rpcOk") : t("admin.rpcDown")}
            </div>
          </div>
          <div>
            <div className="label">{t("admin.lastSlot")}</div>
            <div className="mt-1 text-sm font-semibold tabular">{count(indexer.lastSlot)}</div>
          </div>
          <div>
            <div className="label">{t("admin.subscribedPools")}</div>
            <div className="mt-1 text-sm font-semibold tabular">{count(indexer.subscribedPools)}</div>
          </div>
          <div>
            <div className="label">{t("admin.lastSync")}</div>
            <div className="mt-1 text-sm font-semibold tabular">{indexer.lastSyncAt ? timeAgo(indexer.lastSyncAt) : t("admin.never")}</div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Claimable partner (treasury) fees per pool
// ---------------------------------------------------------------------------

function ClaimableFeesCard({ overview }: { overview: AdminOverview | undefined }) {
  const t = useT();
  const solUsd = useSolUsd();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { connected, signAndSend } = useWalletTx();
  const [claimingCa, setClaimingCa] = useState<string | null>(null);

  const rows = overview?.claimable ?? [];
  const totalPartnerSol = rows.reduce((sum, r) => sum + r.partnerSol, 0);

  const claim = async (ca: string) => {
    if (claimingCa) return;
    setClaimingCa(ca);
    try {
      if (!connected) throw new Error(t("coin.claimConnectWallet"));
      const res = await apiRequest("POST", "/api/admin/claim-tx", { ca });
      const unsigned = (await res.json()) as UnsignedTx;
      const sent = await signAndSend(unsigned, "claim", ca);
      toast({
        title: t("coin.claimSent"),
        description: (
          <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="underline">
            {t("coin.viewTransaction")}
          </a>
        ),
      });
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/overview") });
    } catch (err) {
      toast({ variant: "destructive", title: t("coin.claimFailed"), description: apiErrorMessage(err, t("common.error")) });
    } finally {
      setClaimingCa(null);
    }
  };

  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gold/15 text-gold">
            <Wallet className="h-4 w-4" />
          </span>
          <h2 className="text-base font-bold">{t("admin.claimableFees")}</h2>
        </div>
        {overview && (
          <span className="text-sm font-semibold tabular text-gold">
            {usd(totalPartnerSol, solUsd)} <span className="font-normal text-muted-foreground">· {sol(totalPartnerSol)}</span>
          </span>
        )}
      </div>
      {!overview ? (
        <div className="p-4">
          <ListSkeleton rows={3} height={48} />
        </div>
      ) : rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("admin.noClaimable")}</p>
      ) : (
        <>
          {/* Mobile: stacked rows */}
          <ul className="feed-divide sm:hidden">
            {rows.map((r) => (
              <li key={r.coin.ca} className="flex items-center gap-3 px-4 py-3">
                <Link href={`/${r.coin.ca}`} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                  <img src={r.coin.imageUrl} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-xl bg-muted object-cover" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {r.coin.name} <span className="text-xs font-medium text-muted-foreground">${r.coin.ticker}</span>
                    </div>
                    <div className="text-xs tabular text-gold">{sol(r.partnerSol)}</div>
                  </div>
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 rounded-full"
                  disabled={r.partnerSol <= 0 || claimingCa === r.coin.ca}
                  onClick={() => void claim(r.coin.ca)}
                >
                  {claimingCa === r.coin.ca && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("admin.claim")}
                </Button>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto sm:block">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("admin.pool")}</TableHead>
                  <TableHead className="text-right">{t("admin.partnerFees")}</TableHead>
                  <TableHead className="text-right">{t("admin.creatorFees")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.coin.ca}>
                    <TableCell className="font-medium">
                      <Link href={`/${r.coin.ca}`} className="flex items-center gap-2 hover:underline">
                        <img src={r.coin.imageUrl} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-lg bg-muted object-cover" />
                        <span className="truncate">{r.coin.name}</span>
                        <span className="shrink-0 text-xs font-medium text-muted-foreground">${r.coin.ticker}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-semibold tabular text-gold">{sol(r.partnerSol)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular text-muted-foreground">{sol(r.creatorSol)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-lg"
                        disabled={r.partnerSol <= 0 || claimingCa === r.coin.ca}
                        onClick={() => void claim(r.coin.ca)}
                      >
                        {claimingCa === r.coin.ca && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {t("admin.claim")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Users table
// ---------------------------------------------------------------------------

function UsersTab() {
  const t = useT();
  const [search, setSearch] = useState("");
  const usersKey = `/api/admin/users?search=${encodeURIComponent(search.trim())}`;
  const users = useQuery<User[]>({ queryKey: [usersKey], staleTime: 10_000 });

  return (
    <section className="surface">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("admin.search")}
          aria-label={t("admin.search")}
          className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {users.data && <span className="text-xs text-muted-foreground tabular">{t("admin.usersCount", { n: count(users.data.length) })}</span>}
      </div>
      {users.isLoading ? (
        <div className="p-4">
          <ListSkeleton rows={5} height={40} />
        </div>
      ) : users.isError ? (
        <p className="p-4 text-sm text-destructive">{apiErrorMessage(users.error, t("admin.loadError"))}</p>
      ) : !users.data?.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("admin.noUsers")}</p>
      ) : (
        <>
          {/* Mobile: stacked rows */}
          <ul className="feed-divide sm:hidden">
            {users.data.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                <UserAvatar seed={u.avatarSeed} name={u.username} size={32} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Link href={`/${encodeURIComponent(u.username)}`} className="truncate text-sm font-semibold hover:underline">
                      @{u.username}
                    </Link>
                    {u.isAdmin && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{t("nav.admin")}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {u.walletAddress ? shortCa(u.walletAddress, 6, 6) : "—"} · {dateShort(u.createdAt)}
                  </div>
                </div>
                <Button asChild size="sm" variant="ghost" className="shrink-0 rounded-full">
                  <Link href={`/${encodeURIComponent(u.username)}`}>{t("admin.view")}</Link>
                </Button>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto sm:block">
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("admin.users")}</TableHead>
                  <TableHead>{t("admin.wallet")}</TableHead>
                  <TableHead>{t("admin.joined")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <UserAvatar seed={u.avatarSeed} name={u.username} size={24} />
                        <Link href={`/${encodeURIComponent(u.username)}`} className="hover:underline">
                          @{u.username}
                        </Link>
                        {u.isAdmin && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{t("nav.admin")}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                      {u.walletAddress ? shortCa(u.walletAddress, 6, 6) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{dateShort(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost" className="rounded-lg">
                        <Link href={`/${encodeURIComponent(u.username)}`}>{t("admin.view")}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const t = useT();
  const { isAdmin, isLoading, user } = useAuth();
  const overview = useQuery<AdminOverview>({ queryKey: ["/api/admin/overview"], staleTime: 15_000, enabled: isAdmin });

  if (isLoading) {
    return (
      <PageShell>
        <ListSkeleton rows={3} height={140} />
      </PageShell>
    );
  }

  if (!isAdmin) {
    return <NotFound title={t("admin.onlyAdmins")} hint={user ? t("admin.onlyAdminsHint") : t("admin.loginHint")} />;
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">{t("admin.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("admin.subtitle")}</p>
          </div>
        </div>

        <StatsStrip overview={overview.data} />
        <IndexerCard overview={overview.data} />
        <ClaimableFeesCard overview={overview.data} />

        <section>
          <h2 className="mb-2 text-sm font-bold">{t("admin.users")}</h2>
          <UsersTab />
        </section>
      </div>
    </PageShell>
  );
}
