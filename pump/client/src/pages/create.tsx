import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import type { z } from "zod";
import {
  AlertTriangle,
  ChevronDown,
  ImagePlus,
  Loader2,
  Lock,
  Rocket,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import type { CoinDetail, CoinSummary, CreateCoinInput, PublicUser } from "@shared/schema";
import {
  CREATOR_FEE_SHARE,
  MAX_CREATOR_ALLOCATION,
  SWAP_FEE,
  TOTAL_SUPPLY,
  VIRTUAL_TOKEN_RESERVE,
  VIRTUAL_USDC_RESERVE,
  createCoinSchema,
} from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { CoinCard } from "@/components/CoinCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest } from "@/lib/queryClient";
import { compactUsd, priceUsd, shortCa, tokens as fmtTokens, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

type FormInput = z.input<typeof createCoinSchema>;

const IMAGE_PX = 512;
/** Stay well below the schema's 2,000,000-char limit. */
const MAX_IMAGE_DATA_URL = 1_900_000;
const ACCEPTED_IMAGE_RE = /^image\/(png|jpe?g|webp|gif)$/;
const NAME_MAX = 32;
const TICKER_MAX = 10;
const DESCRIPTION_MAX = 1000;
const ALLOCATION_WARNING = 0.1;
const MAX_INITIAL_BUY = 100_000;

// ---------------------------------------------------------------------------
// Curve maths (mirror of server/curve.ts for the live launch preview)
// ---------------------------------------------------------------------------

interface LaunchPreview {
  launchPrice: number;
  launchMcap: number;
  tokensForSale: number;
  creatorTokens: number;
  /** filled when there is an initial buy */
  buy: { tokensOut: number; fee: number; priceAfter: number; mcapAfter: number } | null;
}

function previewLaunch(allocation: number, initialBuy: number): LaunchPreview {
  const creatorTokens = TOTAL_SUPPLY * allocation;
  const tokensForSale = TOTAL_SUPPLY - creatorTokens;
  const U = VIRTUAL_USDC_RESERVE;
  const T = tokensForSale + VIRTUAL_TOKEN_RESERVE;
  const launchPrice = U / T;
  let buy: LaunchPreview["buy"] = null;
  if (initialBuy > 0) {
    const fee = initialBuy * SWAP_FEE;
    const net = initialBuy - fee;
    const newT = (U * T) / (U + net);
    const tokensOut = Math.min(tokensForSale, T - newT);
    const priceAfter = (U + net) / (T - tokensOut);
    buy = { tokensOut, fee, priceAfter, mcapAfter: priceAfter * TOTAL_SUPPLY };
  }
  return { launchPrice, launchMcap: launchPrice * TOTAL_SUPPLY, tokensForSale, creatorTokens, buy };
}

// ---------------------------------------------------------------------------
// Image helpers: file → 512×512 cover crop → webp (png fallback) data URL
// ---------------------------------------------------------------------------

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
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

let webpSupport: boolean | null = null;
function canvasSupportsWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    webpSupport = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

export async function prepareCoinImage(file: File, size = IMAGE_PX): Promise<string> {
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("decode failed");

  // Cover crop: scale so the shorter side fills the square, centre the longer one.
  const scale = Math.max(size / w, size / h);
  const dw = w * scale;
  const dh = h * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx, dy, dw, dh);

  if (canvasSupportsWebp()) {
    let out = canvas.toDataURL("image/webp", 0.9);
    if (out.length > MAX_IMAGE_DATA_URL) out = canvas.toDataURL("image/webp", 0.75);
    return out;
  }
  const png = canvas.toDataURL("image/png");
  if (png.length <= MAX_IMAGE_DATA_URL) return png;
  return canvas.toDataURL("image/jpeg", 0.88);
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  hint,
  error,
  counter,
  optional,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  counter?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-sm font-semibold">
          {label}
          {optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({t("common.optional")})</span>}
        </Label>
        {counter && <span className="text-[11px] tabular text-muted-foreground">{counter}</span>}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ImageDropzone({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      if (!ACCEPTED_IMAGE_RE.test(file.type)) {
        toast({ variant: "destructive", title: t("create.imageInvalid"), description: t("create.imageHint") });
        return;
      }
      setBusy(true);
      try {
        onChange(await prepareCoinImage(file));
      } catch (err) {
        toast({ variant: "destructive", title: t("common.error"), description: apiErrorMessage(err, t("create.imageFailed")) });
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onChange, toast, t],
  );

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    void pick(file);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        disabled={disabled}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={value ? t("create.imageChange") : t("create.imageDrop")}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "relative flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed p-4 transition-colors",
          dragging ? "border-primary bg-primary/10" : error ? "border-destructive/60 bg-destructive/5" : "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        {value ? (
          <img src={value} alt="" className="h-24 w-24 shrink-0 rounded-xl border border-border bg-muted object-cover shadow" />
        ) : (
          <span className="grid h-24 w-24 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-7 w-7" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{busy ? t("create.imageProcessing") : value ? t("create.imageChange") : t("create.imageDrop")}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t("create.imageHint")}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{t("create.imageResize", { px: IMAGE_PX })}</div>
        </div>
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            aria-label={t("create.imageRemove")}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function EarnBanner() {
  const t = useT();
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/20 text-primary">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-bold text-primary">{t("header.earn")}</div>
        <div className="text-xs text-muted-foreground">{t("header.earnHint")}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const PLACEHOLDER_CREATOR: PublicUser = { id: 0, username: "you", avatarSeed: "you", avatarUrl: null };

export default function CreatePage() {
  const t = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const [linksOpen, setLinksOpen] = useState(false);
  const [initialBuyRaw, setInitialBuyRaw] = useState("");

  const form = useForm<FormInput>({
    // The resolver validates against the schema's output type; the form works with its input type.
    resolver: zodResolver(createCoinSchema) as unknown as Resolver<FormInput>,
    mode: "onTouched",
    defaultValues: {
      name: "",
      ticker: "",
      description: "",
      image: "",
      website: "",
      twitter: "",
      telegram: "",
      creatorAllocation: 0,
      initialBuy: 0,
    },
  });
  const { register, watch, setValue, handleSubmit, formState } = form;
  const { errors, isSubmitted } = formState;

  const name = watch("name") ?? "";
  const ticker = watch("ticker") ?? "";
  const description = watch("description") ?? "";
  const image = watch("image") ?? "";
  const allocation = watch("creatorAllocation") ?? 0;
  const initialBuy = Number(watch("initialBuy") ?? 0) || 0;

  const balance = user?.balance ?? 0;
  const buyTooLarge = !!user && initialBuy > balance + 1e-9;
  const buyTooLargeForCap = initialBuy > MAX_INITIAL_BUY;

  const launch = useMemo(() => previewLaunch(allocation, initialBuy), [allocation, initialBuy]);

  const setImage = useCallback(
    (dataUrl: string) => setValue("image", dataUrl, { shouldDirty: true, shouldValidate: isSubmitted }),
    [setValue, isSubmitted],
  );

  const setInitialBuy = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    const firstDot = cleaned.indexOf(".");
    const normalised = firstDot === -1 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    setInitialBuyRaw(normalised);
    const n = Number(normalised);
    setValue("initialBuy", Number.isFinite(n) && n >= 0 ? n : 0, { shouldDirty: true });
  };

  // Live preview: a synthetic CoinSummary built from the form values.
  const preview = useMemo<CoinSummary>(() => {
    const now = new Date().toISOString();
    const price = launch.buy ? launch.buy.priceAfter : launch.launchPrice;
    const marketCap = launch.buy ? launch.buy.mcapAfter : launch.launchMcap;
    const creator: PublicUser = user
      ? { id: user.id, username: user.username, avatarSeed: user.avatarSeed, avatarUrl: user.avatarUrl }
      : PLACEHOLDER_CREATOR;
    const sold = launch.buy?.tokensOut ?? 0;
    return {
      id: 0,
      ca: "preview",
      name: name.trim() || t("create.namePlaceholder").replace(/^e\.g\.\s*/i, ""),
      ticker: ticker.trim().toUpperCase() || t("create.tickerPlaceholder").replace(/^e\.g\.\s*/i, ""),
      description: description.trim() || t("create.descriptionPlaceholder"),
      imageUrl: image || placeholderImage(name || ticker || "?"),
      website: null,
      twitter: null,
      telegram: null,
      creatorId: creator.id,
      creatorAllocation: allocation,
      realUsdc: launch.buy ? initialBuy - launch.buy.fee : 0,
      curveTokens: launch.tokensForSale - sold,
      circulating: launch.creatorTokens + sold,
      volume: initialBuy,
      buys: launch.buy ? 1 : 0,
      sells: 0,
      feesCollected: launch.buy?.fee ?? 0,
      creatorFees: (launch.buy?.fee ?? 0) * CREATOR_FEE_SHARE,
      graduated: false,
      graduatedAt: null,
      createdAt: now,
      lastTradeAt: launch.buy ? now : null,
      price,
      marketCap,
      progress: 0,
      holders: allocation > 0 || launch.buy ? 1 : 0,
      comments: 0,
      change24h: 0,
      creator,
      lastTrade: null,
    };
  }, [name, ticker, description, image, allocation, initialBuy, launch, user, t]);

  const create = useMutation({
    mutationFn: async (input: CreateCoinInput) => {
      const res = await apiRequest("POST", "/api/coins", input);
      return (await res.json()) as CoinDetail;
    },
    onSuccess: (coin) => {
      qc.setQueryData<CoinDetail>([`/api/coins/${coin.ca}`], coin);
      void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/coins") });
      void qc.invalidateQueries({ queryKey: ["/api/me"] });
      void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      void qc.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: `🚀 ${t("create.created", { ticker: `$${coin.ticker}` })}`,
        description: t("create.createdHint", { ca: shortCa(coin.ca, 6, 6) }),
      });
      navigate(`/${coin.ca}`);
    },
    onError: (err) => {
      toast({ variant: "destructive", title: t("create.failed"), description: apiErrorMessage(err, t("common.error")) });
    },
  });

  const onSubmit = handleSubmit((values) => {
    if (!user) {
      openLogin();
      return;
    }
    if (buyTooLarge || buyTooLargeForCap) return;
    const parsed = createCoinSchema.safeParse(values);
    if (!parsed.success) {
      toast({ variant: "destructive", title: t("common.error"), description: parsed.error.issues[0]?.message ?? t("common.error") });
      return;
    }
    create.mutate({
      ...parsed.data,
      website: parsed.data.website || undefined,
      twitter: parsed.data.twitter || undefined,
      telegram: parsed.data.telegram || undefined,
    });
  });

  // Open the links section automatically when a link field has an error.
  useEffect(() => {
    if (errors.website || errors.twitter || errors.telegram) setLinksOpen(true);
  }, [errors.website, errors.twitter, errors.telegram]);

  const submitting = create.isPending;
  const allocationPct = Math.round(allocation * 100);

  return (
    <PageShell>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        {/* ------------------------------------------------------------ form */}
        <div className="min-w-0 space-y-6">
          <header>
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t("create.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("create.subtitle")}</p>
          </header>

          <EarnBanner />

          {!authLoading && !user && (
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Lock className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-sm font-bold">{t("create.loginRequired")}</div>
                  <div className="text-xs text-muted-foreground">{t("create.loginHint")}</div>
                </div>
              </div>
              <Button type="button" onClick={openLogin} className="rounded-lg font-semibold">
                {t("nav.login")}
              </Button>
            </div>
          )}

          <form onSubmit={onSubmit} noValidate className="space-y-6" aria-busy={submitting}>
            <section className="space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_160px]">
                <Field label={t("create.name")} htmlFor="coin-name" error={errors.name?.message} counter={`${name.length}/${NAME_MAX}`}>
                  <Input
                    id="coin-name"
                    placeholder={t("create.namePlaceholder")}
                    maxLength={NAME_MAX}
                    autoComplete="off"
                    disabled={submitting}
                    className="h-11 rounded-lg"
                    {...register("name")}
                  />
                </Field>
                <Field
                  label={t("create.ticker")}
                  htmlFor="coin-ticker"
                  error={errors.ticker?.message}
                  hint={t("create.tickerHint")}
                  counter={`${ticker.length}/${TICKER_MAX}`}
                >
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">$</span>
                    <Input
                      id="coin-ticker"
                      placeholder={t("create.tickerPlaceholder").replace(/^e\.g\.\s*/i, "")}
                      maxLength={TICKER_MAX}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      disabled={submitting}
                      className="h-11 rounded-lg pl-7 font-semibold uppercase tracking-wide"
                      {...register("ticker", {
                        onChange: (e: ChangeEvent<HTMLInputElement>) => {
                          const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, TICKER_MAX);
                          if (next !== e.target.value) {
                            e.target.value = next;
                            setValue("ticker", next, { shouldDirty: true });
                          }
                        },
                      })}
                    />
                  </div>
                </Field>
              </div>

              <Field
                label={t("create.description")}
                htmlFor="coin-description"
                error={errors.description?.message}
                counter={`${description.length}/${DESCRIPTION_MAX}`}
              >
                <Textarea
                  id="coin-description"
                  placeholder={t("create.descriptionPlaceholder")}
                  maxLength={DESCRIPTION_MAX}
                  rows={4}
                  disabled={submitting}
                  className="min-h-[96px] resize-y rounded-lg"
                  {...register("description")}
                />
              </Field>

              <Field label={t("create.image")} error={errors.image?.message}>
                <ImageDropzone value={image} onChange={setImage} error={errors.image?.message} disabled={submitting} />
              </Field>

              {/* Links (collapsible) */}
              <div className="rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setLinksOpen((v) => !v)}
                  aria-expanded={linksOpen}
                  aria-controls="coin-links"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-semibold hover:bg-accent/40"
                >
                  {t("create.links")}
                  <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", linksOpen && "rotate-180")} />
                </button>
                {linksOpen && (
                  <div id="coin-links" className="grid gap-4 border-t border-border p-3 sm:grid-cols-3">
                    <Field label={t("create.website")} htmlFor="coin-website" error={errors.website?.message}>
                      <Input id="coin-website" type="url" inputMode="url" placeholder="https://" disabled={submitting} className="rounded-lg" {...register("website")} />
                    </Field>
                    <Field label={t("create.twitter")} htmlFor="coin-twitter" error={errors.twitter?.message}>
                      <Input id="coin-twitter" placeholder="@handle" autoComplete="off" disabled={submitting} className="rounded-lg" {...register("twitter")} />
                    </Field>
                    <Field label={t("create.telegram")} htmlFor="coin-telegram" error={errors.telegram?.message}>
                      <Input id="coin-telegram" placeholder="t.me/…" autoComplete="off" disabled={submitting} className="rounded-lg" {...register("telegram")} />
                    </Field>
                  </div>
                )}
              </div>
            </section>

            {/* Economics */}
            <section className="space-y-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="coin-allocation" className="text-sm font-semibold">
                    {t("create.allocation")}
                  </Label>
                  <span className="text-right">
                    <span className="text-xl font-extrabold tabular">{allocationPct}%</span>
                    <span className="ml-2 text-xs tabular text-muted-foreground">{t("create.allocationTokens", { tokens: fmtTokens(launch.creatorTokens) })}</span>
                  </span>
                </div>
                <Slider
                  id="coin-allocation"
                  value={[allocationPct]}
                  min={0}
                  max={Math.round(MAX_CREATOR_ALLOCATION * 100)}
                  step={1}
                  disabled={submitting}
                  onValueChange={([v]) => setValue("creatorAllocation", (v ?? 0) / 100, { shouldDirty: true })}
                  aria-label={t("create.allocation")}
                  className={cn(allocation > ALLOCATION_WARNING && "[&_[role=slider]]:border-gold [&_.bg-primary]:bg-gold")}
                />
                <div className="flex justify-between text-[11px] tabular text-muted-foreground">
                  <span>0%</span>
                  <span>{Math.round(MAX_CREATOR_ALLOCATION * 100)}%</span>
                </div>
                <p className="text-xs text-muted-foreground">{t("create.allocationHint")}</p>
                {allocation > ALLOCATION_WARNING && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gold/10 px-2.5 py-1.5 text-xs font-medium text-gold"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t("create.allocationWarning")}
                  </motion.p>
                )}
                {errors.creatorAllocation?.message && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {errors.creatorAllocation.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="coin-initial-buy" className="text-sm font-semibold">
                    {t("create.initialBuy")}
                  </Label>
                  {user && (
                    <span className="inline-flex items-center gap-1 text-xs tabular text-muted-foreground">
                      <Wallet className="h-3 w-3" />
                      {t("trade.balance")}: <span className="font-semibold text-foreground">{usd(balance)}</span>
                    </span>
                  )}
                </div>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">$</span>
                  <Input
                    id="coin-initial-buy"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={initialBuyRaw}
                    disabled={submitting}
                    onChange={(e) => setInitialBuy(e.target.value)}
                    aria-invalid={buyTooLarge || buyTooLargeForCap}
                    className={cn("h-11 rounded-lg pl-7 pr-16 tabular", (buyTooLarge || buyTooLargeForCap) && "border-destructive focus-visible:ring-destructive")}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">USDC</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[10, 50, 100].map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={submitting}
                      onClick={() => setInitialBuy(String(v))}
                      className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-semibold tabular text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      ${v}
                    </button>
                  ))}
                  {user && balance > 0 && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setInitialBuy((Math.floor(Math.min(balance, MAX_INITIAL_BUY) * 100) / 100).toString())}
                      className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {t("trade.max")}
                    </button>
                  )}
                  {initialBuyRaw && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setInitialBuy("")}
                      className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      {t("trade.reset")}
                    </button>
                  )}
                </div>
                {buyTooLarge ? (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {t("create.insufficient", { balance: usd(balance) })}
                  </p>
                ) : buyTooLargeForCap ? (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {t("create.initialBuyMax", { max: usd(MAX_INITIAL_BUY, { digits: 0 }) })}
                  </p>
                ) : errors.initialBuy?.message ? (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {errors.initialBuy.message}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("create.initialBuyHint")}</p>
                )}
                {launch.buy && (
                  <p className="text-xs tabular text-primary">
                    {t("create.youReceive", { tokens: fmtTokens(launch.buy.tokensOut), ticker: preview.ticker })}
                    <span className="text-muted-foreground"> · {t("trade.fee", { percent: `${(SWAP_FEE * 100).toFixed(1)}%` })}: {usd(launch.buy.fee)}</span>
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3 sm:grid-cols-4">
                <Stat label={t("create.launchPrice")} value={priceUsd(launch.launchPrice)} />
                <Stat label={t("create.launchMcap")} value={compactUsd(launch.launchMcap)} />
                <Stat label={t("create.forSale")} value={fmtTokens(launch.tokensForSale)} />
                <Stat
                  label={t("create.mcapAfterBuy")}
                  value={launch.buy ? compactUsd(launch.buy.mcapAfter) : "—"}
                  valueClass={launch.buy ? "text-primary" : "text-muted-foreground"}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                {t("create.feeNotice", { fee: `${(SWAP_FEE * 100).toFixed(1)}%`, share: `${Math.round(CREATOR_FEE_SHARE * 100)}%` })}
              </p>
            </section>

            <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
              <Button asChild type="button" variant="ghost" className="rounded-lg">
                <Link href="/">{t("common.cancel")}</Link>
              </Button>
              {user ? (
                <Button
                  type="submit"
                  size="lg"
                  disabled={submitting || buyTooLarge || buyTooLargeForCap}
                  className="h-12 rounded-xl px-6 text-base font-bold shadow-[0_0_24px_-6px_hsl(var(--primary)/0.9)]"
                >
                  {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Rocket className="h-5 w-5" />}
                  {submitting ? t("create.creating") : t("create.submit")}
                </Button>
              ) : (
                <Button type="button" size="lg" onClick={openLogin} disabled={authLoading} className="h-12 rounded-xl px-6 text-base font-bold">
                  <Lock className="h-4 w-4" />
                  {t("create.loginRequired")}
                </Button>
              )}
            </div>
          </form>
        </div>

        {/* --------------------------------------------------------- preview */}
        <aside className="min-w-0 space-y-3 lg:sticky lg:top-20">
          <div>
            <h2 className="text-sm font-bold">{t("create.preview")}</h2>
            <p className="text-xs text-muted-foreground">{t("create.previewHint")}</p>
          </div>
          <div className="pointer-events-none select-none" aria-hidden>
            <CoinCard coin={preview} highlight={!!image} />
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-3 py-1">
              <span>{t("create.allocation")}</span>
              <span className="font-semibold tabular text-foreground">
                {allocationPct}% · {fmtTokens(launch.creatorTokens)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 py-1">
              <span>{t("create.forSale")}</span>
              <span className="font-semibold tabular text-foreground">{fmtTokens(launch.tokensForSale)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 py-1">
              <span>{t("create.launchMcap")}</span>
              <span className="font-semibold tabular text-foreground">{compactUsd(launch.launchMcap)}</span>
            </div>
            {launch.buy && (
              <div className="flex items-center justify-between gap-3 py-1">
                <span>{t("create.initialBuy")}</span>
                <span className="font-semibold tabular text-primary">
                  {usd(initialBuy)} → {fmtTokens(launch.buy.tokensOut)} {preview.ticker}
                </span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("truncate text-sm font-bold tabular", valueClass)}>{value}</div>
    </div>
  );
}

/** Inline SVG placeholder shown in the preview card until an image is chosen. */
function placeholderImage(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  const hue1 = h % 360;
  const hue2 = (hue1 + 60 + ((h >> 8) % 90)) % 360;
  const letter = (seed.trim().charAt(0) || "?").toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue1} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 55%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="128" height="128" rx="28" fill="url(#g)"/>` +
    `<text x="64" y="82" font-family="Inter,system-ui,sans-serif" font-size="60" font-weight="800" fill="rgba(255,255,255,0.92)" text-anchor="middle">${escapeXml(letter)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c);
}
