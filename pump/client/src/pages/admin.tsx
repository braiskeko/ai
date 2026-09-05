import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Activity, Coins, Loader2, Search, ShieldAlert, TrendingUp, Users, type LucideIcon } from "lucide-react";
import type { AdminUserRow, PlatformStats, SafeUser } from "@shared/schema";
import { adminCreditSchema } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { compactUsd, dateShort, usd } from "@/lib/format";
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

function StatsStrip() {
  const t = useT();
  const { data, isLoading } = useQuery<PlatformStats>({ queryKey: ["/api/stats"], staleTime: 30_000 });
  const tiles: { key: string; icon: LucideIcon; value: string | null }[] = [
    { key: "home.stats.coins", icon: Coins, value: data ? count(data.coins) : null },
    { key: "home.stats.volume", icon: TrendingUp, value: data ? compactUsd(data.volume) : null },
    { key: "home.stats.traders", icon: Users, value: data ? count(data.traders) : null },
    { key: "home.stats.trades", icon: Activity, value: data ? count(data.trades) : null },
  ];
  return (
    <section>
      <h2 className="mb-2 text-sm font-bold">{t("admin.stats")}</h2>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {tiles.map(({ key, icon: Icon, value }) => (
          <div key={key} className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(key)}</div>
              {isLoading || value === null ? <Skeleton className="mt-1 h-5 w-16" /> : <div className="truncate text-lg font-bold leading-tight tabular">{value}</div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Credit form (react-hook-form + adminCreditSchema)
// ---------------------------------------------------------------------------

type CreditForm = z.infer<typeof adminCreditSchema>;

function CreditCard({ prefill, onApplied }: { prefill: string; onApplied: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const form = useForm<CreditForm>({
    resolver: zodResolver(adminCreditSchema),
    mode: "onChange",
    defaultValues: { username: "", amount: undefined as unknown as number },
  });
  const { register, handleSubmit, setValue, reset, formState } = form;

  // A row's "Credit" button fills the username field.
  useEffect(() => {
    if (prefill) setValue("username", prefill, { shouldValidate: true, shouldDirty: true });
  }, [prefill, setValue]);

  const credit = useMutation({
    mutationFn: async (values: CreditForm) => {
      const res = await apiRequest("POST", "/api/admin/users/credit", {
        username: values.username.replace(/^@/, ""),
        amount: values.amount,
      });
      return (await res.json()) as { user: SafeUser | null; queued: boolean };
    },
    onSuccess: (result, values) => {
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/users") });
      void queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      const handle = values.username.replace(/^@/, "");
      toast({
        title: result.queued ? t("admin.creditQueued") : t("admin.balanceUpdated"),
        description: result.queued
          ? t("admin.creditQueuedHint", { username: handle })
          : t("admin.balanceNow", { username: result.user?.username ?? handle, amount: usd(result.user?.balance ?? 0) }),
      });
      reset({ username: "", amount: undefined as unknown as number });
      onApplied();
    },
    onError: (err) => toast({ variant: "destructive", title: t("admin.creditFailed"), description: apiErrorMessage(err, t("common.error")) }),
  });

  const { errors, isValid } = formState;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <Coins className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold">{t("admin.credit")}</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t("admin.creditHint")}</p>
      <form className="grid gap-3 sm:grid-cols-[1fr_180px_auto]" onSubmit={handleSubmit((values) => credit.mutate(values))} noValidate>
        <div>
          <Label htmlFor="credit-username" className="text-xs">
            {t("admin.username")}
          </Label>
          <Input
            id="credit-username"
            placeholder="@username"
            className="mt-1 rounded-lg"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!errors.username}
            {...register("username", { setValueAs: (v: string) => v.trim().replace(/^@/, "") })}
          />
        </div>
        <div>
          <Label htmlFor="credit-amount" className="text-xs">
            {t("admin.amount")}
          </Label>
          <Input
            id="credit-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            placeholder="1000"
            className="mt-1 rounded-lg tabular"
            aria-invalid={!!errors.amount}
            {...register("amount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
        </div>
        <Button type="submit" disabled={!isValid || credit.isPending} className="self-end rounded-lg font-semibold">
          {credit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("admin.apply")}
        </Button>
      </form>
      {errors.amount?.message && errors.amount.type !== "invalid_type" && <p className="mt-2 text-xs text-down">{t("admin.amountNonZero")}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Users table
// ---------------------------------------------------------------------------

function UsersTab() {
  const t = useT();
  const [search, setSearch] = useState("");
  const [prefill, setPrefill] = useState("");
  const usersKey = `/api/admin/users?search=${encodeURIComponent(search.trim())}`;
  const users = useQuery<AdminUserRow[]>({ queryKey: [usersKey], staleTime: 10_000 });

  return (
    <div className="space-y-4">
      <CreditCard prefill={prefill} onApplied={() => setPrefill("")} />

      <section className="rounded-xl border border-border bg-card">
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
          <div className="overflow-x-auto">
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("admin.users")}</TableHead>
                  <TableHead>{t("admin.email")}</TableHead>
                  <TableHead className="text-right">{t("admin.balance")}</TableHead>
                  <TableHead>{t("admin.joined")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <UserAvatar seed={String(u.id)} name={u.username} size={24} />
                        <Link href={`/u/${encodeURIComponent(u.username)}`} className="hover:underline">
                          @{u.username}
                        </Link>
                        {u.isAdmin && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{t("nav.admin")}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-muted-foreground">{u.email}</TableCell>
                    <TableCell className="text-right font-semibold tabular">{usd(u.balance)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{dateShort(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" className="rounded-lg" onClick={() => setPrefill(u.username)}>
                        {t("admin.creditAction")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const t = useT();
  const { isAdmin, isLoading, user } = useAuth();

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

        <StatsStrip />

        <section>
          <h2 className="mb-2 text-sm font-bold">{t("admin.users")}</h2>
          <UsersTab />
        </section>
      </div>
    </PageShell>
  );
}
