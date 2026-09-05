import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock, Flame, Search, Sparkles, Users, X } from "lucide-react";
import type { MarketSummary } from "@shared/schema";
import { MARKET_CATEGORIES } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { MarketCard } from "@/components/MarketCard";
import { Skeleton } from "@/components/ui/skeleton";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

const SORTS = [
  { id: "volume", label: "Top", icon: BarChart3 },
  { id: "trending", label: "Trending", icon: Flame },
  { id: "newest", label: "New", icon: Sparkles },
  { id: "ending", label: "Ending soon", icon: Clock },
] as const;
type SortId = (typeof SORTS)[number]["id"];

/** URL value "" = Active (server status=open) */
const STATUS = [
  { id: "", label: "Active" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
] as const;
type StatusId = (typeof STATUS)[number]["id"];

const isSort = (v: string): v is SortId => SORTS.some((s) => s.id === v);
const isStatus = (v: string): v is StatusId => STATUS.some((s) => s.id === v);

export default function Markets() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const rawCategory = params.get("category") ?? "";
  const category = (MARKET_CATEGORIES as readonly string[]).includes(rawCategory) ? rawCategory : "All";
  const rawSort = params.get("sort") ?? "volume";
  const sort: SortId = isSort(rawSort) ? rawSort : "volume";
  const rawStatus = params.get("status") ?? "";
  const status: StatusId = isStatus(rawStatus) ? rawStatus : "";
  const q = (params.get("q") ?? "").trim();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    navigate(s ? `/markets?${s}` : "/markets");
  };

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (category !== "All") p.set("category", category);
    p.set("sort", sort);
    if (status === "") p.set("status", "open");
    else p.set("status", status);
    if (q) p.set("search", q);
    return p.toString();
  }, [category, sort, status, q]);

  // Single-string key so live updates can patch every "/api/markets?…" list.
  const { data, isLoading, isError } = useQuery<MarketSummary[]>({ queryKey: [`/api/markets?${qs}`] });

  const filtersActive = q !== "" || category !== "All" || sort !== "volume" || status !== "";
  const featured = useMemo(
    () => (filtersActive ? [] : (data ?? []).filter((m) => m.featured && m.status === "open").slice(0, 3)),
    [data, filtersActive],
  );

  const hasFilters = filtersActive;

  return (
    <PageShell wide className="pb-16">
      {/* Category chips */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-4">
        {["All", ...MARKET_CATEGORIES].map((c) => (
          <button
            key={c}
            onClick={() => setParam("category", c === "All" ? "" : c)}
            aria-pressed={category === c}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              category === c
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Featured hero */}
      {!hasFilters && (isLoading ? (
        <section className="mb-8 grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-2xl" />
          ))}
        </section>
      ) : featured.length > 0 ? (
        <section className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((m) => (
            <FeaturedCard key={m.id} market={m} />
          ))}
        </section>
      ) : null)}

      {/* Sort / status */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1">
          {SORTS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setParam("sort", id === "volume" ? "" : id)}
              aria-pressed={sort === id}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                sort === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 rounded-lg border border-border bg-card p-1">
          {STATUS.map(({ id, label }) => (
            <button
              key={id || "active"}
              onClick={() => setParam("status", id)}
              aria-pressed={status === id}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                status === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Search result count */}
      {q && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Search className="h-4 w-4" />
          <span>
            {isLoading ? "Searching" : `${data?.length ?? 0} result${data?.length === 1 ? "" : "s"}`} for{" "}
            <span className="font-medium text-foreground">&ldquo;{q}&rdquo;</span>
          </span>
          <button
            onClick={() => setParam("q", "")}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium hover:bg-accent"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          title="Couldn't load markets"
          body="Something went wrong while fetching markets. Please try again in a moment."
        />
      ) : data && data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.map((m) => (
            <MarketCard key={m.id} market={m} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={q ? "No markets found" : "No markets here yet"}
          body={
            q
              ? "Try a different search term or clear your filters."
              : hasFilters
                ? "Nothing matches these filters. Try another category or status."
                : "New markets will appear here once they are approved."
          }
          action={
            hasFilters ? (
              <button
                onClick={() => navigate("/markets")}
                className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Clear filters
              </button>
            ) : (
              <Link href="/create" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                Create a market
              </Link>
            )
          }
        />
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------

function leading(market: MarketSummary): { id: number; price: number } {
  if (market.binary) return { id: 0, price: market.prices[0] ?? 0 };
  let id = 0;
  let price = -1;
  market.prices.forEach((p, i) => {
    if (p > price) {
      price = p;
      id = i;
    }
  });
  return { id, price: Math.max(price, 0) };
}

function FeaturedCard({ market }: { market: MarketSummary }) {
  const lead = leading(market);
  const pctValue = Math.round(lead.price * 100);
  const outcome = market.outcomes[lead.id];
  const color = market.binary ? (lead.price >= 0.5 ? "text-yes" : "text-no") : undefined;

  return (
    <Link
      href={`/market/${market.slug}`}
      className="group relative flex min-h-[208px] flex-col overflow-hidden rounded-2xl border border-border bg-card p-6 transition hover:shadow-md"
      style={{
        backgroundImage: "linear-gradient(135deg, hsl(var(--primary) / 0.08), transparent 60%)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-4 -top-6 select-none text-[128px] leading-none opacity-[0.08] transition-transform duration-500 group-hover:scale-110"
      >
        {market.imageEmoji}
      </div>
      <div className="relative flex h-full flex-col">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            {market.category}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Featured
          </span>
        </div>
        <h2 className="line-clamp-3 text-lg font-bold leading-snug">{market.question}</h2>
        <div className="mt-auto flex items-end justify-between gap-4 pt-6">
          <div>
            <div className={cn("tabular text-4xl font-black leading-none", color)} style={color ? undefined : { color: outcome?.color }}>
              {pctValue}%
            </div>
            <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
              {market.binary ? "chance" : outcome?.name ?? "leading"}
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div className="tabular font-medium text-foreground">{usd(market.volume, { compact: true, digits: 0 })} Vol.</div>
            <div className="mt-0.5 inline-flex items-center gap-1">
              <Users className="h-3 w-3" />
              {market.traders} trader{market.traders === 1 ? "" : "s"}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Search className="h-5 w-5" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
