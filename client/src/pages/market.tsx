import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Gavel,
  Loader2,
  SearchX,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import type { MarketDetail, MarketStatus } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { PriceChart } from "@/components/PriceChart";
import { TradePanel } from "@/components/TradePanel";
import { Comments } from "@/components/Comments";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { dateShort, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<MarketStatus, { label: string; className: string }> = {
  pending: { label: "Pending review", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  open: { label: "Open", className: "bg-yes/15 text-yes" },
  closed: { label: "Closed", className: "bg-muted text-muted-foreground" },
  resolved: { label: "Resolved", className: "bg-primary/15 text-primary" },
  rejected: { label: "Rejected", className: "bg-no/15 text-no" },
};

function StatusBadge({ status }: { status: MarketStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", s.className)}>
      {s.label}
    </span>
  );
}

function hexToRgba(hex: string, alpha: number) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(46, 91, 255, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function MarketSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <Skeleton className="h-14 w-14 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
      <Skeleton className="h-[420px] w-full rounded-xl" />
    </div>
  );
}

function StatusBanner({ market }: { market: MarketDetail }) {
  if (market.status === "resolved" && market.resolution !== null) {
    const outcome = market.outcomes[market.resolution];
    const color = outcome?.color ?? "#2E5BFF";
    return (
      <div
        className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold"
        style={{ backgroundColor: hexToRgba(color, 0.12), borderColor: hexToRgba(color, 0.4), color }}
      >
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <span>
          Resolved: {outcome?.name ?? "Unknown"}
          {market.resolvedAt && (
            <span className="ml-2 font-normal opacity-80">· {dateShort(market.resolvedAt)}</span>
          )}
        </span>
      </div>
    );
  }
  if (market.status === "pending") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700 dark:text-amber-300">
        <Clock className="h-5 w-5 shrink-0" />
        Awaiting review by moderators. Only you and admins can see this market until it is approved.
      </div>
    );
  }
  if (market.status === "rejected") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-no/40 bg-no/10 px-4 py-3 text-sm text-no">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <div className="font-semibold">This market was rejected</div>
          {market.rejectionReason && <div className="mt-0.5 opacity-90">{market.rejectionReason}</div>}
        </div>
      </div>
    );
  }
  if (market.status === "closed") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3 text-sm font-medium text-muted-foreground">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        Trading closed, awaiting resolution.
      </div>
    );
  }
  return null;
}

function RulesCard({ market }: { market: MarketDetail }) {
  const [expanded, setExpanded] = useState(false);
  const long = market.rules.length > 400;
  const rules = long && !expanded ? `${market.rules.slice(0, 400).trimEnd()}…` : market.rules;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-base font-bold">Rules</h2>
      {market.description && (
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{market.description}</p>
      )}
      <div className="mt-4 rounded-lg bg-muted/60 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resolution criteria</div>
        <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">{rules}</p>
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            {expanded ? (
              <>
                Show less <ChevronUp className="h-4 w-4" />
              </>
            ) : (
              <>
                Show more <ChevronDown className="h-4 w-4" />
              </>
            )}
          </button>
        )}
      </div>
      <dl className="mt-4 divide-y divide-border text-sm">
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-muted-foreground">Resolver</dt>
          <dd className="font-medium">Foresight moderators</dd>
        </div>
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-muted-foreground">End date</dt>
          <dd className="font-medium tabular">{dateShort(market.endDate)}</dd>
        </div>
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge status={market.status} />
          </dd>
        </div>
        <div className="flex items-center justify-between py-2.5">
          <dt className="text-muted-foreground">Liquidity</dt>
          <dd className="font-medium tabular">{usd(market.liquidity, { digits: 0 })}</dd>
        </div>
      </dl>
    </section>
  );
}

function AdminResolveCard({ market }: { market: MarketDetail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [outcomeId, setOutcomeId] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const resolve = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/markets/${market.id}/resolve`, { outcomeId: id });
      return (await res.json()) as unknown;
    },
    onSuccess: async () => {
      toast({ title: "Market resolved", description: `Winning outcome: ${market.outcomes[Number(outcomeId)]?.name}` });
      setConfirmOpen(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: [`/api/markets/${market.slug}`] }),
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/markets") }),
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/admin/markets") }),
        qc.invalidateQueries({ queryKey: ["/api/portfolio"] }),
      ]);
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not resolve market", description: apiErrorMessage(err) });
    },
  });

  const chosen = outcomeId !== "" ? market.outcomes[Number(outcomeId)] : undefined;

  return (
    <section className="rounded-xl border border-dashed border-primary/40 bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-bold">
        <ShieldAlert className="h-4 w-4 text-primary" />
        Admin
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Resolving pays $1.00 per winning share and closes the market permanently.
      </p>
      <div className="mt-3 space-y-2">
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
          className="w-full rounded-lg"
          variant="outline"
          disabled={!chosen || resolve.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          <Gavel className="mr-2 h-4 w-4" />
          Resolve market
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resolve this market?</AlertDialogTitle>
            <AlertDialogDescription>
              "{market.question}" will be resolved to <span className="font-semibold text-foreground">{chosen?.name}</span>.
              Holders of that outcome receive $1.00 per share. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolve.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={resolve.isPending || !chosen}
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
    </section>
  );
}

export default function MarketPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const search = useSearch();
  const { isAdmin } = useAuth();

  const { data: market, isLoading, error } = useQuery<MarketDetail>({
    queryKey: [`/api/markets/${slug}`],
    enabled: !!slug,
  });

  const requestedOutcome = useMemo(() => {
    const raw = new URLSearchParams(search).get("outcome");
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [search]);

  const [selectedOutcome, setSelectedOutcome] = useState<number>(requestedOutcome ?? 0);

  // Re-apply the ?outcome= preselection when it changes or once the market loads.
  useEffect(() => {
    if (requestedOutcome !== null) setSelectedOutcome(requestedOutcome);
  }, [requestedOutcome, slug]);
  useEffect(() => {
    if (market && selectedOutcome >= market.outcomes.length) setSelectedOutcome(0);
  }, [market, selectedOutcome]);

  const notFound = !!error && /^404/.test(error.message);

  if (isLoading) {
    return (
      <PageShell>
        <MarketSkeleton />
      </PageShell>
    );
  }

  if (notFound || (!market && !isLoading)) {
    return (
      <PageShell>
        <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-muted">
            <SearchX className="h-7 w-7 text-muted-foreground" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Market not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {notFound
              ? "This market does not exist, or it is still awaiting review and only visible to its creator."
              : apiErrorMessage(error, "We could not load this market.")}
          </p>
          <Button asChild className="mt-6 rounded-lg">
            <Link href="/markets">Browse markets</Link>
          </Button>
        </div>
      </PageShell>
    );
  }

  if (!market) return null;

  const leadIndex = market.binary
    ? 0
    : market.prices.reduce((best, p, i) => (p > market.prices[best] ? i : best), 0);
  const leadPrice = market.prices[leadIndex] ?? 0;
  const change = market.change24h;
  const showChange = Math.abs(change) >= 0.005;
  const canAdminResolve = isAdmin && (market.status === "open" || market.status === "closed");
  const sortedOutcomes = market.binary
    ? market.outcomes
    : [...market.outcomes].sort((a, b) => (market.prices[b.id] ?? 0) - (market.prices[a.id] ?? 0));

  return (
    <PageShell>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left column */}
        <div className="min-w-0 space-y-6">
          <header className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-muted text-3xl">
                {market.imageEmoji}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold leading-tight">{market.question}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span className="tabular">{usd(market.volume, { compact: true, digits: 0 })} Vol.</span>
                  <span aria-hidden>·</span>
                  <span>Ends {dateShort(market.endDate)}</span>
                  <span aria-hidden>·</span>
                  <Link
                    href={`/markets?category=${encodeURIComponent(market.category)}`}
                    className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground hover:bg-accent"
                  >
                    {market.category}
                  </Link>
                  <span aria-hidden>·</span>
                  <span>
                    by <span className="font-medium text-foreground">@{market.creator.username}</span>
                  </span>
                </div>
              </div>
            </div>

            {market.binary ? (
              <div className="flex flex-wrap items-end gap-3">
                <div className="text-4xl font-bold leading-none tabular" style={{ color: market.outcomes[0]?.color }}>
                  {pct(leadPrice)}
                  <span className="ml-2 text-base font-semibold text-muted-foreground">chance</span>
                </div>
                {showChange && (
                  <div
                    className={cn(
                      "mb-0.5 inline-flex items-center gap-1 text-sm font-semibold tabular",
                      change > 0 ? "text-yes" : "text-no",
                    )}
                  >
                    {change > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    {change > 0 ? "+" : "-"}
                    {Math.abs(Math.round(change * 100))}% today
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sortedOutcomes.map((o) => {
                  const selected = o.id === selectedOutcome;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setSelectedOutcome(o.id)}
                      aria-pressed={selected}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        selected ? "border-transparent font-semibold" : "border-border bg-card hover:bg-accent",
                      )}
                      style={
                        selected
                          ? { backgroundColor: hexToRgba(o.color, 0.14), color: o.color, borderColor: hexToRgba(o.color, 0.5) }
                          : undefined
                      }
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.color }} />
                      <span className={cn(!selected && "text-foreground")}>{o.name}</span>
                      <span className="tabular font-bold">{pct(market.prices[o.id] ?? 0)}</span>
                    </button>
                  );
                })}
                {showChange && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 self-center text-sm font-semibold tabular",
                      change > 0 ? "text-yes" : "text-no",
                    )}
                  >
                    {change > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    {change > 0 ? "+" : "-"}
                    {Math.abs(Math.round(change * 100))}% today
                  </span>
                )}
              </div>
            )}
          </header>

          <section className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <PriceChart
              history={market.priceHistory}
              outcomes={market.outcomes}
              binary={market.binary}
              height={300}
              selectedOutcome={selectedOutcome}
              resolved={market.status === "resolved"}
            />
          </section>

          {/* Trade panel on mobile: under the chart, before rules */}
          <div className="space-y-4 lg:hidden">
            <TradePanel market={market} selectedOutcome={selectedOutcome} onSelectOutcome={setSelectedOutcome} />
            {canAdminResolve && <AdminResolveCard market={market} />}
          </div>

          <StatusBanner market={market} />

          <RulesCard market={market} />

          <Comments market={market} />
        </div>

        {/* Right column */}
        <aside className="hidden lg:block">
          <div className="sticky top-20 space-y-4">
            <TradePanel market={market} selectedOutcome={selectedOutcome} onSelectOutcome={setSelectedOutcome} />
            {canAdminResolve && <AdminResolveCard market={market} />}
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
