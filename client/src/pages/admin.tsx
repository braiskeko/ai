import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Check, ExternalLink, Gavel, Loader2, ShieldAlert, Star, X } from "lucide-react";
import type { MarketSummary, Withdrawal, WithdrawalStatus } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { OutcomeChip } from "@/components/OutcomeChip";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { dateShort, endsIn, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

const PENDING_KEY = ["/api/admin/markets?status=pending"] as const;
const OPEN_KEY = ["/api/admin/markets?status=open"] as const;
const CLOSED_KEY = ["/api/admin/markets?status=closed"] as const;
const WITHDRAWALS_KEY = ["/api/admin/withdrawals"] as const;

const isPrefixed = (prefix: string) => (q: { queryKey: readonly unknown[] }) =>
  typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(prefix);

async function invalidateMarketQueries() {
  await Promise.all([
    queryClient.invalidateQueries({ predicate: isPrefixed("/api/admin/markets") }),
    queryClient.invalidateQueries({ predicate: isPrefixed("/api/markets") }),
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] }),
  ]);
}

function shortAddress(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const STATUS_PILL: Record<WithdrawalStatus, string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  sent: "bg-yes/15 text-yes",
  failed: "bg-no/15 text-no",
};

function CountBadge({ n }: { n: number | undefined }) {
  if (!n) return null;
  return <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{n}</span>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-12 text-center">
      <div className="font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function ListSkeleton({ rows = 3, height = 160 }: { rows?: number; height?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="rounded-xl" style={{ height }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending review
// ---------------------------------------------------------------------------

function ReviewCard({ market }: { market: MarketSummary }) {
  const { toast } = useToast();
  const [featured, setFeatured] = useState(market.featured);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);

  const review = useMutation({
    mutationFn: async (body: { action: "approve" | "reject"; reason?: string; featured?: boolean }) => {
      const res = await apiRequest("POST", `/api/admin/markets/${market.id}/review`, body);
      return (await res.json()) as MarketSummary;
    },
    onSuccess: async (_m, vars) => {
      toast({
        title: vars.action === "approve" ? "Market approved" : "Market rejected",
        description: market.question,
      });
      await invalidateMarketQueries();
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Review failed", description: apiErrorMessage(err) });
    },
  });

  const longRules = market.rules.length > 400;
  const rules = longRules && !rulesOpen ? `${market.rules.slice(0, 400).trimEnd()}…` : market.rules;

  return (
    <article className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-muted text-2xl">{market.imageEmoji}</div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-snug">{market.question}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 font-semibold text-foreground">{market.category}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <UserAvatar seed={market.creator.avatarSeed} name={market.creator.username} size={16} />@{market.creator.username}
            </span>
            <span>·</span>
            <span>Ends {dateShort(market.endDate)} ({endsIn(market.endDate).toLowerCase()})</span>
            <span>·</span>
            <span>Submitted {dateShort(market.createdAt)}</span>
            <span>·</span>
            <span className="tabular">Liquidity {usd(market.liquidity, { digits: 0 })}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</div>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{market.description}</p>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rules</div>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{rules}</p>
          {longRules && (
            <button type="button" className="mt-1 text-xs font-semibold text-primary hover:underline" onClick={() => setRulesOpen((v) => !v)}>
              {rulesOpen ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outcomes</div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {market.outcomes.map((o) => (
            <OutcomeChip key={o.id} name={o.name} color={o.color} price={market.prices[o.id] ?? 0} />
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="rounded-lg bg-yes text-white hover:bg-yes/90"
            disabled={review.isPending}
            onClick={() => review.mutate({ action: "approve", featured })}
          >
            {review.isPending && review.variables?.action === "approve" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Approve
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={featured} onCheckedChange={(v) => setFeatured(v === true)} aria-label="Feature on homepage" />
            <Star className="h-3.5 w-3.5 text-amber-500" />
            Feature on homepage
          </label>
          <div className="flex-1" />
          <Button
            type="button"
            variant={rejecting ? "ghost" : "outline"}
            className={cn("rounded-lg", !rejecting && "text-no hover:text-no")}
            disabled={review.isPending}
            onClick={() => setRejecting((v) => !v)}
          >
            <X className="mr-2 h-4 w-4" />
            {rejecting ? "Cancel" : "Reject"}
          </Button>
        </div>
        {rejecting && (
          <div className="rounded-lg border border-no/40 bg-no/5 p-3">
            <Label htmlFor={`reject-${market.id}`} className="text-sm font-semibold text-no">
              Reason for rejection
            </Label>
            <Textarea
              id={`reject-${market.id}`}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown to the creator, e.g. 'Resolution source is ambiguous'."
              className="mt-1.5 rounded-lg bg-card"
            />
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="destructive"
                className="rounded-lg"
                disabled={review.isPending || reason.trim().length < 3}
                onClick={() => review.mutate({ action: "reject", reason: reason.trim() })}
              >
                {review.isPending && review.variables?.action === "reject" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm rejection
              </Button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function PendingTab() {
  const { data, isLoading, error } = useQuery<MarketSummary[]>({ queryKey: [...PENDING_KEY] });
  if (isLoading) return <ListSkeleton rows={2} height={260} />;
  if (error) return <EmptyState title="Could not load pending markets" body={apiErrorMessage(error)} />;
  if (!data || data.length === 0) {
    return <EmptyState title="Nothing to review" body="New market submissions will appear here." />;
  }
  return (
    <div className="space-y-4">
      {data.map((m) => (
        <ReviewCard key={m.id} market={m} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

function ResolveRow({ market }: { market: MarketSummary }) {
  const { toast } = useToast();
  const [outcomeId, setOutcomeId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const chosen = outcomeId !== "" ? market.outcomes[Number(outcomeId)] : undefined;

  const resolve = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/markets/${market.id}/resolve`, { outcomeId: id });
      return (await res.json()) as MarketSummary;
    },
    onSuccess: async () => {
      setConfirmOpen(false);
      toast({ title: "Market resolved", description: `${market.question} → ${chosen?.name}` });
      await Promise.all([
        invalidateMarketQueries(),
        queryClient.invalidateQueries({ queryKey: [`/api/markets/${market.slug}`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] }),
      ]);
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not resolve", description: apiErrorMessage(err) });
    },
  });

  const ended = market.status === "closed";
  const lead = market.prices.reduce((best, p, i) => (p > market.prices[best] ? i : best), 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-xl">{market.imageEmoji}</div>
        <div className="min-w-0">
          <Link href={`/market/${market.slug}`} className="line-clamp-2 text-sm font-semibold leading-snug hover:underline">
            {market.question}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-semibold",
                ended ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-yes/15 text-yes",
              )}
            >
              {ended ? "Ended — awaiting resolution" : "Open"}
            </span>
            <span>{ended ? `Ended ${dateShort(market.endDate)}` : endsIn(market.endDate)}</span>
            <span>·</span>
            <span className="tabular">{usd(market.volume, { compact: true, digits: 0 })} Vol.</span>
            <span>·</span>
            <span>
              Leading: <span className="font-medium text-foreground">{market.outcomes[lead]?.name}</span>{" "}
              {Math.round((market.prices[lead] ?? 0) * 100)}%
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 md:w-[360px]">
        <Select value={outcomeId} onValueChange={setOutcomeId}>
          <SelectTrigger className="rounded-lg">
            <SelectValue placeholder="Winning outcome" />
          </SelectTrigger>
          <SelectContent>
            {market.outcomes.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.color }} />
                  {o.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={ended ? "default" : "outline"}
          className="shrink-0 rounded-lg"
          disabled={!chosen || resolve.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          <Gavel className="mr-2 h-4 w-4" />
          Resolve
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resolve this market?</AlertDialogTitle>
            <AlertDialogDescription>
              "{market.question}" will resolve to <span className="font-semibold text-foreground">{chosen?.name}</span>.
              {!ended && " This market has not ended yet — trading will stop immediately."} Holders of the winning outcome are
              paid $1.00 per share. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolve.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!chosen || resolve.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (chosen) resolve.mutate(chosen.id);
              }}
            >
              {resolve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm resolution
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResolveTab() {
  const closed = useQuery<MarketSummary[]>({ queryKey: [...CLOSED_KEY] });
  const open = useQuery<MarketSummary[]>({ queryKey: [...OPEN_KEY] });

  const merged = useMemo(() => {
    const byEnd = (a: MarketSummary, b: MarketSummary) => Date.parse(a.endDate) - Date.parse(b.endDate);
    return [...(closed.data ?? [])].sort(byEnd).concat([...(open.data ?? [])].sort(byEnd));
  }, [closed.data, open.data]);

  if (closed.isLoading || open.isLoading) return <ListSkeleton rows={4} height={88} />;
  const err = closed.error ?? open.error;
  if (err && merged.length === 0) return <EmptyState title="Could not load markets" body={apiErrorMessage(err)} />;
  if (merged.length === 0) return <EmptyState title="No markets to resolve" body="Open and ended markets will be listed here." />;

  return (
    <div className="space-y-3">
      {(closed.data?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {closed.data?.length} market{closed.data?.length === 1 ? "" : "s"} ended and awaiting resolution are listed first.
        </p>
      )}
      {merged.map((m) => (
        <ResolveRow key={m.id} market={m} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

function WithdrawalRow({ w, explorer }: { w: Withdrawal; explorer: string }) {
  const { toast } = useToast();
  const [txHash, setTxHash] = useState("");

  const update = useMutation({
    mutationFn: async (body: { status: "sent" | "failed"; txHash?: string; error?: string }) => {
      const res = await apiRequest("POST", `/api/admin/withdrawals/${w.id}`, body);
      return (await res.json()) as Withdrawal;
    },
    onSuccess: async (_w, vars) => {
      toast({
        title: vars.status === "sent" ? "Withdrawal marked as sent" : "Withdrawal marked as failed",
        description: `${usd(w.amount)} to ${shortAddress(w.toAddress)}`,
      });
      await queryClient.invalidateQueries({ queryKey: [...WITHDRAWALS_KEY] });
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Update failed", description: apiErrorMessage(err) });
    },
  });

  const pending = w.status === "pending";
  const hashValid = txHash.trim().length > 0;

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
        {format(new Date(w.createdAt), "MMM d, yyyy HH:mm")}
      </TableCell>
      <TableCell className="text-sm tabular">#{w.userId}</TableCell>
      <TableCell>
        <a
          href={`${explorer}/address/${w.toAddress}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
        >
          {shortAddress(w.toAddress)}
          <ExternalLink className="h-3 w-3" />
        </a>
      </TableCell>
      <TableCell className="text-right font-semibold tabular">{usd(w.amount)}</TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-semibold capitalize", STATUS_PILL[w.status])}>
            {w.status}
          </span>
          {w.error && <span className="text-xs text-no">{w.error}</span>}
        </div>
      </TableCell>
      <TableCell>
        {pending ? (
          <div className="flex min-w-[320px] items-center gap-2">
            <Input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x… transaction hash"
              className="h-8 rounded-md font-mono text-xs"
              aria-label="Transaction hash"
              spellCheck={false}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0 rounded-md bg-yes text-white hover:bg-yes/90"
              disabled={!hashValid || update.isPending}
              onClick={() => update.mutate({ status: "sent", txHash: txHash.trim() })}
            >
              {update.isPending && update.variables?.status === "sent" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Mark sent
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 rounded-md text-no hover:text-no"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "failed", error: "Rejected by admin" })}
            >
              {update.isPending && update.variables?.status === "failed" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Mark failed
            </Button>
          </div>
        ) : w.txHash ? (
          <a
            href={`${explorer}/tx/${w.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
          >
            {w.txHash.length > 14 ? `${w.txHash.slice(0, 8)}…${w.txHash.slice(-6)}` : w.txHash}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function WithdrawalsTab() {
  const config = useConfig();
  const { data, isLoading, error } = useQuery<Withdrawal[]>({ queryKey: [...WITHDRAWALS_KEY] });
  const explorer = config?.chain.explorer ?? "";

  if (isLoading) return <ListSkeleton rows={1} height={240} />;
  if (error) return <EmptyState title="Could not load withdrawals" body={apiErrorMessage(error)} />;
  if (!data || data.length === 0) return <EmptyState title="No withdrawals" body="User withdrawal requests will appear here." />;

  const sorted = [...data].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (b.status === "pending" && a.status !== "pending") return 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  const pendingCount = data.filter((w) => w.status === "pending").length;

  return (
    <div className="space-y-3">
      {config && !config.withdrawalsEnabled && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          Automatic payouts are disabled. Send each pending withdrawal from the treasury wallet, then paste the transaction hash and mark it as sent.
        </p>
      )}
      <p className="text-xs text-muted-foreground tabular">
        {pendingCount} pending · {data.length} total
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>To</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((w) => (
              <WithdrawalRow key={w.id} w={w} explorer={explorer} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { isAdmin, isLoading, user } = useAuth();
  const pending = useQuery<MarketSummary[]>({ queryKey: [...PENDING_KEY], enabled: isAdmin });
  const closed = useQuery<MarketSummary[]>({ queryKey: [...CLOSED_KEY], enabled: isAdmin });
  const withdrawals = useQuery<Withdrawal[]>({ queryKey: [...WITHDRAWALS_KEY], enabled: isAdmin });

  if (isLoading) {
    return (
      <PageShell>
        <ListSkeleton rows={3} height={140} />
      </PageShell>
    );
  }

  if (!isAdmin) {
    return (
      <PageShell>
        <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-muted text-muted-foreground">
            <ShieldAlert className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Admins only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {user ? "Your account does not have moderator permissions." : "Log in with an admin account to access this page."}
          </p>
          <Button asChild variant="outline" className="mt-6 rounded-lg">
            <Link href="/markets">Back to markets</Link>
          </Button>
        </div>
      </PageShell>
    );
  }

  const pendingWithdrawals = withdrawals.data?.filter((w) => w.status === "pending").length;

  return (
    <PageShell wide>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Admin</h1>
            <p className="text-sm text-muted-foreground">Review submissions, resolve markets and process withdrawals.</p>
          </div>
        </div>

        <Tabs defaultValue="pending">
          <TabsList className="h-auto flex-wrap rounded-lg">
            <TabsTrigger value="pending" className="rounded-md">
              Pending review
              <CountBadge n={pending.data?.length} />
            </TabsTrigger>
            <TabsTrigger value="resolve" className="rounded-md">
              Resolve
              <CountBadge n={closed.data?.length} />
            </TabsTrigger>
            <TabsTrigger value="withdrawals" className="rounded-md">
              Withdrawals
              <CountBadge n={pendingWithdrawals} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="mt-4">
            <PendingTab />
          </TabsContent>
          <TabsContent value="resolve" className="mt-4">
            <ResolveTab />
          </TabsContent>
          <TabsContent value="withdrawals" className="mt-4">
            <WithdrawalsTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}
