import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format } from "date-fns";
import { ArrowRight, Briefcase, History, LogIn, PieChart } from "lucide-react";
import type { Portfolio, PortfolioPosition } from "@shared/schema";
import { YES_COLOR, NO_COLOR } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { cents, shares as fmtShares, signedUsd, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

function hexToRgba(hex: string, alpha: number) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(46, 91, 255, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function outcomeColor(market: { binary: boolean; outcomes: { id: number; color: string }[] }, outcomeId: number) {
  if (market.binary) return outcomeId === 0 ? YES_COLOR : NO_COLOR;
  return market.outcomes[outcomeId]?.color ?? "#2E5BFF";
}

function OutcomePill({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex max-w-[140px] items-center gap-1.5 truncate rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: hexToRgba(color, 0.14), color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function PnlText({ value, className }: { value: number; className?: string }) {
  const neutral = Math.abs(value) < 0.005;
  return (
    <span className={cn("tabular font-semibold", neutral ? "text-muted-foreground" : value > 0 ? "text-yes" : "text-no", className)}>
      {signedUsd(value)}
    </span>
  );
}

function SummaryTile({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-bold tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function HistoryChart({ history }: { history: Portfolio["history"] }) {
  const data = useMemo(
    () => history.map((h) => ({ t: new Date(h.t).getTime(), v: Math.round(h.v * 100) / 100 })),
    [history],
  );
  if (data.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">
        Your portfolio history will appear here after your first trade.
      </div>
    );
  }
  const first = data[0].v;
  const last = data[data.length - 1].v;
  const color = last >= first ? YES_COLOR : NO_COLOR;
  const min = Math.min(...data.map((d) => d.v));
  const max = Math.max(...data.map((d) => d.v));
  const pad = Math.max((max - min) * 0.15, 1);
  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="portfolio-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t: number) => format(new Date(t), "MMM d")}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            orientation="right"
            domain={[Math.max(0, min - pad), max + pad]}
            tickFormatter={(v: number) => usd(v, { compact: true, digits: 0 })}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: "hsl(var(--border))" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { t: number; v: number };
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                  <div className="text-muted-foreground">{format(new Date(p.t), "MMM d, yyyy HH:mm")}</div>
                  <div className="mt-0.5 font-semibold tabular">{usd(p.v)}</div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill="url(#portfolio-area)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function PositionsTable({ positions }: { positions: PortfolioPosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-border py-12 text-center">
        <PieChart className="h-8 w-8 text-muted-foreground" />
        <div className="mt-3 font-semibold">No open positions</div>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">Buy shares in a market and they will show up here.</p>
        <Button asChild variant="outline" className="mt-4 rounded-lg">
          <Link href="/markets">Explore markets</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <Table className="min-w-[820px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right">Shares</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead className="text-right">Current</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">P&amp;L</TableHead>
            <TableHead className="w-[80px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => {
            const outcome = p.market.outcomes[p.outcomeId];
            const color = outcomeColor(p.market, p.outcomeId);
            const avg = p.shares > 0 ? p.costBasis / p.shares : 0;
            return (
              <TableRow key={p.id}>
                <TableCell className="max-w-[320px]">
                  <Link href={`/market/${p.market.slug}`} className="flex items-center gap-2.5 hover:underline">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-base">
                      {p.market.imageEmoji}
                    </span>
                    <span className="line-clamp-2 text-sm font-medium leading-snug">{p.market.question}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <OutcomePill name={outcome?.name ?? `#${p.outcomeId}`} color={color} />
                </TableCell>
                <TableCell className="text-right tabular">{fmtShares(p.shares)}</TableCell>
                <TableCell className="text-right tabular text-muted-foreground">{cents(avg)}</TableCell>
                <TableCell className="text-right tabular">{cents(p.currentPrice)}</TableCell>
                <TableCell className="text-right tabular font-medium">{usd(p.currentValue)}</TableCell>
                <TableCell className="text-right">
                  <PnlText value={p.unrealizedPnl} />
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="outline" className="h-8 rounded-lg">
                    <Link href={`/market/${p.market.slug}?outcome=${p.outcomeId}`}>Trade</Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function HistoryTable({ trades }: { trades: Portfolio["trades"] }) {
  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-border py-12 text-center">
        <History className="h-8 w-8 text-muted-foreground" />
        <div className="mt-3 font-semibold">No trades yet</div>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">Every buy and sell you make will be listed here.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Time</TableHead>
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right">Shares</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => {
            const outcome = t.market.outcomes[t.outcomeId];
            const binary =
              t.market.outcomes.length === 2 &&
              t.market.outcomes[0]?.name.toLowerCase() === "yes" &&
              t.market.outcomes[1]?.name.toLowerCase() === "no";
            const color = outcomeColor({ binary, outcomes: t.market.outcomes }, t.outcomeId);
            return (
              <TableRow key={t.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
                  {format(new Date(t.createdAt), "MMM d, HH:mm")}
                </TableCell>
                <TableCell className="max-w-[300px]">
                  <Link href={`/market/${t.market.slug}`} className="flex items-center gap-2.5 hover:underline">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-sm">
                      {t.market.imageEmoji}
                    </span>
                    <span className="line-clamp-1 text-sm font-medium">{t.market.question}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className={cn("text-sm font-semibold", t.side === "buy" ? "text-yes" : "text-no")}>
                    {t.side === "buy" ? "Buy" : "Sell"}
                  </span>
                </TableCell>
                <TableCell>
                  <OutcomePill name={outcome?.name ?? `#${t.outcomeId}`} color={color} />
                </TableCell>
                <TableCell className="text-right tabular">{fmtShares(t.shares)}</TableCell>
                <TableCell className="text-right tabular">{cents(t.avgPrice)}</TableCell>
                <TableCell className="text-right tabular font-medium">{usd(t.amount)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[220px] rounded-xl" />
      <Skeleton className="h-[280px] rounded-xl" />
    </div>
  );
}

export default function PortfolioPage() {
  const { user, isLoading: authLoading, openLogin } = useAuth();

  const { data, isLoading, error } = useQuery<Portfolio>({
    queryKey: ["/api/portfolio"],
    enabled: !!user,
  });

  if (authLoading) {
    return (
      <PageShell>
        <PortfolioSkeleton />
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
            <Briefcase className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Log in to see your portfolio</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Track your positions, profit and loss, and trade history in one place.
          </p>
          <Button className="mt-6 rounded-lg" onClick={openLogin}>
            <LogIn className="mr-2 h-4 w-4" />
            Log in
          </Button>
        </div>
      </PageShell>
    );
  }

  if (isLoading) {
    return (
      <PageShell>
        <PortfolioSkeleton />
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell>
        <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center">
          <h1 className="text-lg font-bold">Could not load your portfolio</h1>
          <p className="mt-2 text-sm text-muted-foreground">{apiErrorMessage(error)}</p>
        </div>
      </PageShell>
    );
  }

  const openPositions = data.positions.filter((p) => p.shares > 1e-9);

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Portfolio</h1>
            <p className="text-sm text-muted-foreground">@{user.username}</p>
          </div>
          <Button asChild variant="outline" className="rounded-lg">
            <Link href="/wallet">
              Manage wallet <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <SummaryTile label="Portfolio value" value={usd(data.totalValue)} />
          <SummaryTile label="Cash" value={<span className="text-yes">{usd(data.balance)}</span>} />
          <SummaryTile label="Positions value" value={usd(data.positionsValue)} sub={`${openPositions.length} open`} />
          <SummaryTile label="Unrealized P&L" value={<PnlText value={data.unrealizedPnl} className="text-xl" />} />
          <SummaryTile label="Realized P&L" value={<PnlText value={data.realizedPnl} className="text-xl" />} />
          <SummaryTile label="Volume traded" value={usd(data.volume, { compact: true, digits: 0 })} sub={`${data.trades.length} trades`} />
        </div>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold">Portfolio value over time</h2>
          </div>
          <HistoryChart history={data.history} />
        </section>

        <Tabs defaultValue="positions">
          <TabsList className="rounded-lg">
            <TabsTrigger value="positions" className="rounded-md">
              Positions
              {openPositions.length > 0 && (
                <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{openPositions.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="rounded-md">
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="positions" className="mt-4">
            <PositionsTable positions={openPositions} />
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <HistoryTable trades={data.trades} />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}
