import { useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Flame, Clock, Sparkles, BarChart3 } from "lucide-react";
import type { MarketSummary } from "@shared/schema";
import { MARKET_CATEGORIES } from "@shared/schema";
import { MarketCard } from "@/components/MarketCard";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const SORTS = [
  { id: "volume", label: "Top", icon: BarChart3 },
  { id: "trending", label: "Trending", icon: Flame },
  { id: "newest", label: "New", icon: Sparkles },
  { id: "ending", label: "Ending soon", icon: Clock },
] as const;

const STATUS = [
  { id: "", label: "Active" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
] as const;

export default function Home() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const category = params.get("category") ?? "All";
  const sort = params.get("sort") ?? "volume";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    navigate(s ? `/?${s}` : "/");
  };

  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (category !== "All") p.set("category", category);
    if (sort) p.set("sort", sort);
    if (status === "") p.set("status", "open");
    else if (status !== "all") p.set("status", status);
    if (q) p.set("search", q);
    return `/api/markets?${p.toString()}`;
  }, [category, sort, status, q]);

  // Key includes the base so live updates can patch every markets list.
  const { data, isLoading } = useQuery<MarketSummary[]>({
    queryKey: ["/api/markets", apiUrl],
    queryFn: async () => {
      const r = await fetch(apiUrl, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const featured = useMemo(() => (data ?? []).filter((m) => m.featured && m.status === "open").slice(0, 3), [data]);
  const showHero = !q && category === "All" && sort === "volume" && status === "" && featured.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16">
      {/* Category chips */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-4">
        {["All", ...MARKET_CATEGORIES].map((c) => (
          <button
            key={c}
            onClick={() => setParam("category", c === "All" ? "" : c)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              category === c ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {showHero && (
        <section className="mb-8 grid gap-4 lg:grid-cols-3">
          {featured.map((m, i) => (
            <FeaturedCard key={m.id} market={m} large={i === 0} />
          ))}
        </section>
      )}

      {/* Sort / status */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-card p-1">
          {SORTS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setParam("sort", id === "volume" ? "" : id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                sort === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 rounded-lg bg-card p-1">
          {STATUS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setParam("status", id)}
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

      {q && (
        <p className="mb-4 text-sm text-muted-foreground">
          {data?.length ?? 0} result{data?.length === 1 ? "" : "s"} for <span className="text-foreground">“{q}”</span>
        </p>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.map((m) => (
            <MarketCard key={m.id} market={m} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/60 p-16 text-center text-muted-foreground">
          No markets match those filters.
        </div>
      )}
    </div>
  );
}

function FeaturedCard({ market, large }: { market: MarketSummary; large: boolean }) {
  const [, navigate] = useLocation();
  const yes = Math.round(market.yesPrice * 100);
  return (
    <button
      onClick={() => navigate(`/market/${market.slug}`)}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-card to-background p-6 text-left transition-colors hover:border-border",
        large && "lg:row-span-2 lg:p-8",
      )}
    >
      <div className="absolute -right-6 -top-6 text-[120px] opacity-10 select-none">{market.imageEmoji}</div>
      <div className="relative flex h-full flex-col">
        <span className="mb-3 w-fit rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">
          {market.category}
        </span>
        <h2 className={cn("font-bold leading-tight", large ? "text-2xl lg:text-3xl" : "text-lg")}>{market.question}</h2>
        <div className="mt-auto flex items-end justify-between pt-6">
          <div>
            <div className={cn("font-black tabular", large ? "text-5xl" : "text-3xl", yes >= 50 ? "text-yes" : "text-no")}>
              {yes}%
            </div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">chance</div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div className="tabular">
              {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact" }).format(market.volume)}{" "}
              Vol.
            </div>
            <div>{market.traders} traders</div>
          </div>
        </div>
      </div>
    </button>
  );
}
