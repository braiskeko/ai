import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { addDays, format } from "date-fns";
import { Info, Loader2, LogIn, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  createMarketSchema,
  MARKET_CATEGORIES,
  OUTCOME_COLORS,
  YES_COLOR,
  NO_COLOR,
  type MarketStatus,
  type MarketSummary,
} from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { MarketCard } from "@/components/MarketCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { dateShort, endsIn } from "@/lib/format";
import { cn } from "@/lib/utils";

type FormInput = z.input<typeof createMarketSchema>;
type MarketKind = "binary" | "multi";

const EMOJIS = ["🔮", "📈", "🗳️", "₿", "⚽", "🏀", "🚀", "🤖", "🎬", "🎵", "🧪", "🌍", "💼", "🏛️", "🎮", "🌡️"] as const;
const LIQUIDITY_OPTIONS = [
  { value: 500, label: "$500 · Low", hint: "Prices move quickly" },
  { value: 1000, label: "$1,000 · Standard", hint: "Balanced" },
  { value: 5000, label: "$5,000 · Deep", hint: "Prices move slowly" },
] as const;

const STATUS_PILL: Record<MarketStatus, { label: string; className: string }> = {
  pending: { label: "Pending review", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  open: { label: "Open", className: "bg-yes/15 text-yes" },
  closed: { label: "Closed", className: "bg-muted text-muted-foreground" },
  resolved: { label: "Resolved", className: "bg-primary/15 text-primary" },
  rejected: { label: "Rejected", className: "bg-no/15 text-no" },
};

function StatusPill({ status }: { status: MarketStatus }) {
  const s = STATUS_PILL[status];
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", s.className)}>
      {s.label}
    </span>
  );
}

function toDateTimeLocal(d: Date) {
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

function MyMarkets() {
  const { data, isLoading, error } = useQuery<MarketSummary[]>({ queryKey: ["/api/me/markets"] });

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-base font-bold">My markets</h2>
      {isLoading ? (
        <div className="mt-3 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <p className="mt-3 text-sm text-muted-foreground">{apiErrorMessage(error, "Could not load your markets.")}</p>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">You have not created any markets yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {data.map((m) => {
            const canOpen = m.status !== "rejected";
            const row = (
              <>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-lg">{m.imageEmoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{m.question}</span>
                  <span className="block text-xs text-muted-foreground">
                    {m.category} · {m.status === "resolved" || m.status === "closed" ? `Ended ${dateShort(m.endDate)}` : endsIn(m.endDate)}
                  </span>
                  {m.status === "rejected" && m.rejectionReason && (
                    <span className="mt-0.5 block text-xs text-no">Reason: {m.rejectionReason}</span>
                  )}
                </span>
                <StatusPill status={m.status} />
              </>
            );
            return (
              <li key={m.id}>
                {canOpen ? (
                  <Link href={`/market/${m.slug}`} className="flex items-center gap-3 py-2.5 hover:bg-accent/40 -mx-2 px-2 rounded-lg">
                    {row}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 py-2.5">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CreateMarketForm() {
  const { user, isAdmin } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [kind, setKind] = useState<MarketKind>("binary");
  const [yesProb, setYesProb] = useState(50);

  const form = useForm<FormInput>({
    resolver: zodResolver(createMarketSchema),
    mode: "onBlur",
    defaultValues: {
      question: "",
      description: "",
      rules: "",
      category: undefined,
      imageEmoji: "🔮",
      endDate: toDateTimeLocal(addDays(new Date(), 7)),
      outcomes: ["Yes", "No"],
      initialProbabilities: [0.5, 0.5],
      liquidity: 1000,
    },
  });

  const question = form.watch("question") ?? "";
  const description = form.watch("description") ?? "";
  const rules = form.watch("rules") ?? "";
  const category = form.watch("category");
  const imageEmoji = form.watch("imageEmoji") ?? "🔮";
  const endDate = form.watch("endDate") ?? "";
  const outcomes = form.watch("outcomes") ?? ["Yes", "No"];
  const liquidity = form.watch("liquidity") ?? 1000;

  // Keep the Yes/No probabilities in sync with the slider.
  useEffect(() => {
    if (kind === "binary") {
      const p = yesProb / 100;
      form.setValue("initialProbabilities", [p, Math.round((1 - p) * 100) / 100], { shouldValidate: false });
    }
  }, [kind, yesProb, form]);

  const switchKind = (next: MarketKind) => {
    if (next === kind) return;
    setKind(next);
    if (next === "binary") {
      form.setValue("outcomes", ["Yes", "No"], { shouldValidate: false });
      form.setValue("initialProbabilities", [yesProb / 100, 1 - yesProb / 100], { shouldValidate: false });
    } else {
      form.setValue("outcomes", ["", ""], { shouldValidate: false });
      form.setValue("initialProbabilities", undefined, { shouldValidate: false });
    }
    form.clearErrors(["outcomes", "initialProbabilities"]);
  };

  const setOutcome = (i: number, value: string) => {
    const next = [...outcomes];
    next[i] = value;
    form.setValue("outcomes", next, { shouldDirty: true });
  };
  const addOutcome = () => {
    if (outcomes.length >= 8) return;
    form.setValue("outcomes", [...outcomes, ""], { shouldDirty: true });
  };
  const removeOutcome = (i: number) => {
    if (outcomes.length <= 2) return;
    form.setValue(
      "outcomes",
      outcomes.filter((_, idx) => idx !== i),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const outcomesError = form.formState.errors.outcomes;
  const outcomesRootMessage =
    (outcomesError && "message" in outcomesError && typeof outcomesError.message === "string" && outcomesError.message) ||
    (outcomesError && "root" in outcomesError && outcomesError.root?.message) ||
    undefined;
  const outcomeItemError = (i: number): string | undefined => {
    const e = outcomesError as unknown as Array<{ message?: string } | undefined> | undefined;
    return Array.isArray(e) ? e[i]?.message : undefined;
  };

  const preview = useMemo<MarketSummary | null>(() => {
    if (!user) return null;
    const binary = kind === "binary";
    const names = binary ? ["Yes", "No"] : outcomes.map((o, i) => o.trim() || `Outcome ${i + 1}`);
    const prices = binary
      ? [yesProb / 100, 1 - yesProb / 100]
      : names.map(() => 1 / Math.max(names.length, 1));
    const parsedEnd = Date.parse(endDate);
    const iso = Number.isNaN(parsedEnd) ? addDays(new Date(), 7).toISOString() : new Date(parsedEnd).toISOString();
    const now = new Date().toISOString();
    return {
      id: 0,
      slug: "preview",
      question: question.trim() || "Your question will appear here",
      description,
      rules,
      category: category ?? "Crypto",
      imageEmoji: imageEmoji.trim() || "🔮",
      creatorId: user.id,
      status: "open",
      binary,
      outcomes: names.map((name, id) => ({
        id,
        name,
        color: binary ? (id === 0 ? YES_COLOR : NO_COLOR) : OUTCOME_COLORS[id % OUTCOME_COLORS.length],
      })),
      resolution: null,
      rejectionReason: null,
      liquidity: Number(liquidity) || 1000,
      q: names.map(() => 0),
      volume: 0,
      featured: false,
      endDate: iso,
      createdAt: now,
      publishedAt: now,
      resolvedAt: null,
      prices,
      traders: 0,
      change24h: 0,
      creator: { id: user.id, username: user.username, avatarSeed: user.avatarSeed },
      commentCount: 0,
    };
  }, [user, kind, outcomes, yesProb, endDate, question, description, rules, category, imageEmoji, liquidity]);

  const create = useMutation({
    mutationFn: async (values: FormInput) => {
      const binary = kind === "binary";
      const body = {
        question: values.question.trim(),
        description: values.description.trim(),
        rules: values.rules.trim(),
        category: values.category,
        imageEmoji: (values.imageEmoji ?? "🔮").trim() || "🔮",
        endDate: new Date(values.endDate).toISOString(),
        outcomes: binary ? ["Yes", "No"] : (values.outcomes ?? []).map((o) => o.trim()),
        initialProbabilities: binary ? [yesProb / 100, Math.round((100 - yesProb)) / 100] : undefined,
        liquidity: Number(values.liquidity ?? 1000),
      };
      const res = await apiRequest("POST", "/api/markets", body);
      return (await res.json()) as MarketSummary;
    },
    onSuccess: async (market) => {
      if (market.status === "open") {
        toast({ title: "Market published", description: "Your market is live and open for trading." });
      } else {
        toast({ title: "Submitted for review", description: "Moderators will review your market shortly." });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/me/markets"] }),
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/markets") }),
      ]);
      navigate(`/market/${market.slug}`);
    },
    onError: (err) => {
      toast({ variant: "destructive", title: "Could not create market", description: apiErrorMessage(err) });
    },
  });

  const onSubmit = (values: FormInput) => create.mutate(values);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="min-w-0 space-y-6">
          <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              Markets are reviewed by moderators before going live. Admins publish instantly.
              {isAdmin && <span className="ml-1 font-semibold text-primary">You are an admin, so this market will open immediately.</span>}
            </p>
          </div>

          <section className="space-y-5 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-base font-bold">Question</h2>

            <FormField
              control={form.control}
              name="question"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Question</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Will Bitcoin close above $100k on December 31?"
                      maxLength={160}
                      className="rounded-lg"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="flex justify-between">
                    <span>Phrase it so it has a clear yes/no or single-winner answer.</span>
                    <span className="tabular">{question.length}/160</span>
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="imageEmoji"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Icon</FormLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {EMOJIS.map((e) => (
                        <button
                          key={e}
                          type="button"
                          onClick={() => field.onChange(e)}
                          aria-label={`Use ${e}`}
                          aria-pressed={field.value === e}
                          className={cn(
                            "grid h-9 w-9 place-items-center rounded-lg border text-lg transition-colors",
                            field.value === e ? "border-primary bg-primary/10" : "border-border bg-muted/60 hover:bg-accent",
                          )}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                    <FormControl>
                      <Input
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        maxLength={8}
                        className="h-9 w-20 rounded-lg text-center text-lg"
                        aria-label="Custom emoji"
                      />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select value={field.value ?? ""} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="rounded-lg">
                          <SelectValue placeholder="Choose a category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MARKET_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End date</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" className="rounded-lg tabular" min={toDateTimeLocal(new Date())} {...field} />
                    </FormControl>
                    <FormDescription>Trading stops at this time; resolution follows.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Context traders need to understand the question." className="rounded-lg" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="rules"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Resolution rules</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={5}
                      placeholder="This market resolves Yes if … according to <source> as of <time, timezone>. If the source is unavailable …"
                      className="rounded-lg"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>Name the source, the timezone and how edge cases resolve.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <section className="space-y-5 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-base font-bold">Outcomes</h2>

            <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="Market type">
              {(
                [
                  { key: "binary", label: "Yes / No" },
                  { key: "multi", label: "Multiple outcomes" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="tab"
                  aria-selected={kind === opt.key}
                  onClick={() => switchKind(opt.key)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
                    kind === opt.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {kind === "binary" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Initial probability</span>
                  <span className="tabular">
                    <span className="font-semibold text-yes">Yes {yesProb}%</span>
                    <span className="mx-1.5 text-muted-foreground">·</span>
                    <span className="font-semibold text-no">No {100 - yesProb}%</span>
                  </span>
                </div>
                <Slider
                  min={2}
                  max={98}
                  step={1}
                  value={[yesProb]}
                  onValueChange={(v) => setYesProb(v[0] ?? 50)}
                  aria-label="Initial Yes probability"
                />
                <p className="text-xs text-muted-foreground">Where trading starts. Pick your best estimate of the true odds.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  {outcomes.map((value, i) => {
                    const itemError = outcomeItemError(i);
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <span
                          className="mt-3 h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }}
                        />
                        <div className="flex-1">
                          <Input
                            value={value}
                            maxLength={40}
                            placeholder={`Outcome ${i + 1}`}
                            onChange={(e) => setOutcome(i, e.target.value)}
                            onBlur={() => form.trigger("outcomes")}
                            className={cn("rounded-lg", itemError && "border-destructive")}
                            aria-label={`Outcome ${i + 1}`}
                          />
                          {itemError && <p className="mt-1 text-xs font-medium text-destructive">{itemError}</p>}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 shrink-0 rounded-lg text-muted-foreground"
                          disabled={outcomes.length <= 2}
                          onClick={() => removeOutcome(i)}
                          aria-label={`Remove outcome ${i + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {outcomesRootMessage && <p className="text-sm font-medium text-destructive">{outcomesRootMessage}</p>}
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg"
                    disabled={outcomes.length >= 8}
                    onClick={addOutcome}
                  >
                    <Plus className="mr-1.5 h-4 w-4" /> Add outcome
                  </Button>
                  <span className="text-xs text-muted-foreground tabular">{outcomes.length}/8 · starts at equal odds</span>
                </div>
              </div>
            )}

            <FormField
              control={form.control}
              name="liquidity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Liquidity</FormLabel>
                  <Select value={String(field.value ?? 1000)} onValueChange={(v) => field.onChange(Number(v))}>
                    <FormControl>
                      <SelectTrigger className="rounded-lg sm:w-72">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LIQUIDITY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={String(o.value)}>
                          <span>{o.label}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{o.hint}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>Higher liquidity = prices move less per trade.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
            <Button type="button" variant="ghost" className="rounded-lg" onClick={() => navigate("/markets")}>
              Cancel
            </Button>
            <Button type="submit" className="h-11 rounded-lg px-6" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              {isAdmin ? "Publish market" : "Submit for review"}
            </Button>
          </div>
        </form>
      </Form>

      <aside className="space-y-6">
        <div className="lg:sticky lg:top-20">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live preview</div>
          {preview && (
            <div className="pointer-events-none select-none" aria-hidden>
              <MarketCard market={preview} />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">This is how your market will appear in listings.</p>
        </div>
      </aside>
    </div>
  );
}

export default function CreatePage() {
  const { user, isLoading, openLogin } = useAuth();

  if (isLoading) {
    return (
      <PageShell>
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-[520px] rounded-xl" />
          </div>
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-border bg-card p-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Log in to create a market</h1>
          <p className="mt-2 text-sm text-muted-foreground">Ask any question about the future and let the crowd forecast it.</p>
          <Button className="mt-6 rounded-lg" onClick={openLogin}>
            <LogIn className="mr-2 h-4 w-4" />
            Log in
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Create a market</h1>
          <p className="text-sm text-muted-foreground">Good markets have a precise question, a trusted source and a clear end date.</p>
        </div>
        <CreateMarketForm />
        <MyMarkets />
      </div>
    </PageShell>
  );
}
