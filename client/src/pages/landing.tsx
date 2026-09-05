import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Coins,
  LogIn,
  MessageSquare,
  ShieldCheck,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import type { MarketSummary, PlatformStats } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { MarketCard } from "@/components/MarketCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Index and price of the outcome currently leading the market (Yes for binary). */
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

const compactNumber = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Eased count-up from 0 to `target`, restarting whenever the target changes. */
function useCountUp(target: number, duration = 1400) {
  const [value, setValue] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduce]);
  return value;
}

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Landing() {
  const { user, isLoading, openLogin } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (user) navigate("/markets", { replace: true });
  }, [user, navigate]);

  if (user || isLoading) return null;

  return (
    <PageShell wide className="!px-0 !py-0">
      <Hero onSignUp={openLogin} />
      <StatsStrip />
      <Ticker />
      <Trending />
      <HowItWorks />
      <Features />
      <FinalCta onSignUp={openLogin} />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero({ onSignUp }: { onSignUp: () => void }) {
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Gradient wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% -10%, hsl(var(--primary) / 0.28), transparent 70%), linear-gradient(180deg, hsl(var(--primary) / 0.06), transparent 60%)",
        }}
      />
      {/* Subtle grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 70% 70% at 50% 0%, black 30%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 50% 0%, black 30%, transparent 100%)",
        }}
      />

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="relative mx-auto flex max-w-7xl flex-col items-center px-4 pb-16 pt-16 text-center sm:pb-24 sm:pt-24"
      >
        <motion.div
          variants={fadeUp}
          className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yes opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-yes" />
          </span>
          Live prediction markets, settled in USDC
        </motion.div>

        <motion.h1
          variants={fadeUp}
          className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl"
        >
          Trade on what{" "}
          <span className="bg-gradient-to-r from-primary to-[hsl(228_100%_72%)] bg-clip-text text-transparent">
            happens next
          </span>
        </motion.h1>

        <motion.p variants={fadeUp} className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
          Prediction markets let you buy shares in the outcome of real-world events — prices move with the
          crowd&apos;s beliefs, and every winning share pays out $1.
        </motion.p>

        <motion.div variants={fadeUp} className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={onSignUp}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 transition hover:bg-primary/90"
          >
            Sign up
            <ArrowRight className="h-4 w-4" />
          </button>
          <Link
            href="/markets"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 text-sm font-semibold transition hover:bg-accent"
          >
            <BarChart3 className="h-4 w-4" />
            Explore markets
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------------

function StatsStrip() {
  const { data, isLoading } = useQuery<PlatformStats>({ queryKey: ["/api/stats"] });
  const stats = data ?? { volume: 0, traders: 0, openMarkets: 0, trades: 0 };

  const items: { label: string; value: number; format: (n: number) => string; icon: typeof Coins }[] = [
    { label: "Volume traded", value: stats.volume, format: (n) => usd(n, { compact: true, digits: 0 }), icon: Coins },
    { label: "Traders", value: stats.traders, format: (n) => compactNumber(Math.round(n)), icon: Users },
    { label: "Open markets", value: stats.openMarkets, format: (n) => compactNumber(Math.round(n)), icon: BarChart3 },
    { label: "Trades", value: stats.trades, format: (n) => compactNumber(Math.round(n)), icon: Activity },
  ];

  return (
    <section className="border-b border-border bg-card/40">
      <div className="mx-auto grid max-w-7xl grid-cols-2 divide-border px-4 sm:grid-cols-4 sm:divide-x">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col items-center gap-1 py-6 text-center sm:py-7">
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <StatValue value={item.value} format={item.format} />
            )}
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatValue({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <div className="tabular text-2xl font-extrabold sm:text-3xl">{format(v)}</div>;
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function useTopMarkets() {
  return useQuery<MarketSummary[]>({ queryKey: ["/api/markets?sort=volume"] });
}

function Ticker() {
  const { data } = useTopMarkets();
  const reduce = useReducedMotion();
  const items = (data ?? []).filter((m) => m.status === "open").slice(0, 12);
  if (items.length === 0) return null;
  const loop = [...items, ...items];

  return (
    <section className="overflow-hidden border-b border-border bg-background py-3">
      <motion.div
        className="flex w-max gap-3 px-2"
        animate={reduce ? undefined : { x: ["0%", "-50%"] }}
        transition={{ duration: Math.max(30, items.length * 4), ease: "linear", repeat: Infinity }}
      >
        {loop.map((m, i) => {
          const lead = leading(m);
          const name = m.outcomes[lead.id]?.name ?? "Yes";
          const positive = m.binary ? lead.price >= 0.5 : true;
          return (
            <Link
              key={`${m.id}-${i}`}
              href={`/market/${m.slug}`}
              className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm transition hover:bg-accent"
            >
              <span className="text-base leading-none">{m.imageEmoji}</span>
              <span className="max-w-[260px] truncate font-medium">{m.question}</span>
              <span
                className={cn("tabular font-bold", m.binary ? (positive ? "text-yes" : "text-no") : undefined)}
                style={m.binary ? undefined : { color: m.outcomes[lead.id]?.color }}
              >
                {m.binary ? "" : `${name} `}
                {Math.round(lead.price * 100)}%
              </span>
            </Link>
          );
        })}
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trending markets
// ---------------------------------------------------------------------------

function Trending() {
  const { data, isLoading } = useTopMarkets();
  const markets = (data ?? []).filter((m) => m.status === "open").slice(0, 6);

  return (
    <section className="mx-auto max-w-7xl px-4 py-14 sm:py-20">
      <SectionHeading
        eyebrow="Trending"
        title="Markets people are trading right now"
        action={
          <Link href="/markets" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            View all <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : markets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          No open markets yet — be the first to{" "}
          <Link href="/create" className="font-medium text-primary hover:underline">
            create one
          </Link>
          .
        </div>
      ) : (
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {markets.map((m) => (
            <motion.div key={m.id} variants={fadeUp} className="flex">
              <div className="flex w-full [&>*]:w-full">
                <MarketCard market={m} />
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

function HowItWorks() {
  const config = useConfig();
  const chainName = config?.chain.name ?? "the network";
  const steps = [
    {
      icon: LogIn,
      title: "Sign in",
      body: "Create an account in seconds with Google, Apple or a magic link sent to your email.",
    },
    {
      icon: Wallet,
      title: `Deposit USDC on ${chainName}`,
      body: "Every account gets a personal deposit address. Send USDC and your balance updates as soon as it confirms.",
    },
    {
      icon: TrendingUp,
      title: "Buy Yes or No shares",
      body: "Prices reflect the market's probability. When the market resolves, each winning share pays $1.",
    },
  ];

  return (
    <section className="border-y border-border bg-card/40">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:py-20">
        <SectionHeading eyebrow="How it works" title="From sign-up to your first trade in three steps" />
        <motion.ol
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="grid gap-4 md:grid-cols-3"
        >
          {steps.map((s, i) => (
            <motion.li
              key={s.title}
              variants={fadeUp}
              className="relative rounded-xl border border-border bg-card p-6 transition hover:shadow-md"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="grid h-11 w-11 place-items-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="h-5 w-5" />
                </div>
                <span className="tabular text-sm font-bold text-muted-foreground">0{i + 1}</span>
              </div>
              <h3 className="text-lg font-bold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function Features() {
  const features = [
    {
      icon: Zap,
      title: "Real-time prices",
      body: "Every trade moves the market instantly. Watch probabilities update live across the site.",
    },
    {
      icon: ShieldCheck,
      title: "Community-created markets",
      body: "Anyone can propose a market. Moderators review every question and its resolution rules before it goes live.",
    },
    {
      icon: MessageSquare,
      title: "Comments on every market",
      body: "Debate the odds, share your reasoning and see what positions commenters actually hold.",
    },
    {
      icon: Wallet,
      title: "On-chain USDC deposits",
      body: "A personal deposit address for every account. Withdraw whenever you like.",
    },
    {
      icon: Trophy,
      title: "Portfolio & leaderboard",
      body: "Track your positions, P&L and volume, and climb the ranks against other forecasters.",
    },
    {
      icon: BarChart3,
      title: "Multi-outcome markets",
      body: "Not everything is Yes or No. Trade across up to eight outcomes with prices that always sum to 100%.",
    },
  ];

  return (
    <section className="mx-auto max-w-7xl px-4 py-14 sm:py-20">
      <SectionHeading eyebrow="Features" title="Everything you need to forecast well" />
      <motion.div
        variants={stagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {features.map((f) => (
          <motion.div
            key={f.title}
            variants={fadeUp}
            className="group rounded-xl border border-border bg-card p-5 transition hover:shadow-md"
          >
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-muted text-foreground transition group-hover:bg-primary/10 group-hover:text-primary">
              <f.icon className="h-5 w-5" />
            </div>
            <h3 className="font-bold">{f.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Final CTA
// ---------------------------------------------------------------------------

function FinalCta({ onSignUp }: { onSignUp: () => void }) {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-16 sm:pb-24">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5 }}
        className="relative overflow-hidden rounded-2xl bg-primary px-6 py-12 text-center text-primary-foreground sm:px-12 sm:py-16"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.5) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
          }}
        />
        <div className="relative">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Put your forecasts to the test</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm text-primary-foreground/80 sm:text-base">
            Join thousands of traders pricing the future. Sign up free — deposit only when you&apos;re ready.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              onClick={onSignUp}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-white px-6 text-sm font-semibold text-primary shadow-md transition hover:bg-white/90"
            >
              Create your account <ArrowRight className="h-4 w-4" />
            </button>
            <Link
              href="/markets"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-white/30 px-6 text-sm font-semibold text-primary-foreground transition hover:bg-white/10"
            >
              Browse markets
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function SectionHeading({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-primary">{eyebrow}</div>
        <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}
