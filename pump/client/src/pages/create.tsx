import { useCallback, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { ChevronDown, ImagePlus, Loader2, Lock, Rocket, Sparkles, Wallet, X } from "lucide-react";
import type { PreparedCoin, SentTx, UnsignedTx, WalletView } from "@shared/schema";
import { CREATOR_FEE_SHARE, GRADUATION_MCAP_USD, LAUNCH_MCAP_USD, SWAP_FEE, prepareCoinSchema } from "@shared/schema";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth, apiErrorMessage } from "@/hooks/useAuth";
import { useConfig } from "@/hooks/useConfig";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useWalletTx } from "@/lib/solana";
import { cn } from "@/lib/utils";

type FormInput = z.input<typeof prepareCoinSchema>;
type Phase = "idle" | "preparing" | "signing" | "confirming";

const IMAGE_PX = 512;
/** Stay well below the schema's 2,000,000-char limit. */
const MAX_IMAGE_DATA_URL = 1_900_000;
const ACCEPTED_IMAGE_RE = /^image\/(png|jpe?g|webp|gif)$/;
const NAME_MAX = 32;
const TICKER_MAX = 10;
const DESCRIPTION_MAX = 1000;
const MAX_INITIAL_BUY_SOL = 1000;
const DEFAULT_SLIPPAGE_BPS = 500;
/** Left unspent so the wallet always has SOL for network + swap fees. */
const FEE_RESERVE_SOL = 0.01;

// ---------------------------------------------------------------------------
// Local formatting — lib/format.ts is owned by another agent.
// ---------------------------------------------------------------------------

function fmtSol(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "0";
  const s = Math.abs(n).toFixed(digits).replace(/\.?0+$/, "");
  return (n < 0 ? "-" : "") + (s || "0");
}

function fmtCompactUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${abs.toFixed(0)}`;
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

/** Simple square preview built from the raw form fields — the shared CoinCard is owned by another agent. */
function PreviewCard({ name, ticker, description, image }: { name: string; ticker: string; description: string; image: string }) {
  const t = useT();
  const displayName = name.trim() || t("create.namePlaceholder").replace(/^e\.g\.\s*/i, "");
  const displayTicker = ticker.trim().toUpperCase() || t("create.tickerPlaceholder").replace(/^e\.g\.\s*/i, "");
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        {image ? (
          <img src={image} alt="" className="h-14 w-14 shrink-0 rounded-xl border border-border object-cover" />
        ) : (
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-muted text-lg font-black text-muted-foreground">
            {(displayName.trim().charAt(0) || "?").toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{displayName}</div>
          <div className="truncate text-xs font-semibold text-primary">${displayTicker}</div>
        </div>
      </div>
      {description.trim() && <p className="mt-3 line-clamp-3 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CreatePage() {
  const t = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { user, isLoading: authLoading, openLogin } = useAuth();
  const config = useConfig();
  const { publicKey, connected, signAndSend } = useWalletTx();
  const [linksOpen, setLinksOpen] = useState(false);
  const [initialBuyRaw, setInitialBuyRaw] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");

  const walletLinked = !!user?.walletAddress;
  const canLaunch = walletLinked && connected && !!publicKey;

  const { data: walletView } = useQuery<WalletView | null>({
    queryKey: ["/api/wallet"],
    queryFn: getQueryFn<WalletView | null>({ on401: "returnNull" }),
    enabled: walletLinked,
    staleTime: 15_000,
  });
  const balanceSol = walletView?.balanceSol ?? 0;
  const spendableSol = Math.max(0, balanceSol - FEE_RESERVE_SOL);

  const form = useForm<FormInput>({
    // The resolver validates against the schema's output type; the form works with its input type.
    resolver: zodResolver(prepareCoinSchema) as unknown as Resolver<FormInput>,
    mode: "onTouched",
    defaultValues: { name: "", ticker: "", description: "", image: "", website: "", twitter: "", telegram: "" },
  });
  const { register, watch, setValue, handleSubmit, formState } = form;
  const { errors, isSubmitted } = formState;

  const name = watch("name") ?? "";
  const ticker = watch("ticker") ?? "";
  const description = watch("description") ?? "";
  const image = watch("image") ?? "";

  const initialBuySol = Number(initialBuyRaw) || 0;
  const buyTooLarge = walletLinked && initialBuySol > spendableSol + 1e-9;
  const buyTooLargeForCap = initialBuySol > MAX_INITIAL_BUY_SOL;

  const setImage = useCallback(
    (dataUrl: string) => setValue("image", dataUrl, { shouldDirty: true, shouldValidate: isSubmitted }),
    [setValue, isSubmitted],
  );

  const setInitialBuy = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    const firstDot = cleaned.indexOf(".");
    const normalised = firstDot === -1 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    setInitialBuyRaw(normalised);
  };

  const submitting = phase !== "idle";

  const onSubmit = handleSubmit(async (values) => {
    if (!user || !canLaunch) {
      openLogin();
      return;
    }
    if (buyTooLarge || buyTooLargeForCap) return;
    const parsed = prepareCoinSchema.safeParse(values);
    if (!parsed.success) {
      toast({ variant: "destructive", title: t("common.error"), description: parsed.error.issues[0]?.message ?? t("common.error") });
      return;
    }
    try {
      setPhase("preparing");
      const prepRes = await apiRequest("POST", "/api/coins/prepare", {
        ...parsed.data,
        website: parsed.data.website || undefined,
        twitter: parsed.data.twitter || undefined,
        telegram: parsed.data.telegram || undefined,
      });
      const prepared = (await prepRes.json()) as PreparedCoin;

      const txRes = await apiRequest("POST", "/api/coins/create-tx", {
        prepareId: prepared.id,
        wallet: publicKey,
        initialBuySol,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      const unsigned = (await txRes.json()) as UnsignedTx;

      setPhase("signing");
      const sent: SentTx = await signAndSend(unsigned, "create", unsigned.mint, () => setPhase("confirming"));

      void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/coins") });
      void qc.invalidateQueries({ queryKey: ["/api/portfolio"] });
      void qc.invalidateQueries({ queryKey: ["/api/wallet"] });
      void qc.invalidateQueries({ queryKey: ["/api/stats"] });

      const ca = sent.coin?.ca ?? unsigned.mint;
      if (!ca) throw new Error(t("create.failed"));
      toast({ title: `🚀 ${t("create.created", { ticker: `$${parsed.data.ticker}` })}`, description: t("create.createdHint", { ca }) });
      navigate(`/${ca}`);
    } catch (err) {
      toast({ variant: "destructive", title: t("create.failed"), description: apiErrorMessage(err, t("common.error")) });
    } finally {
      setPhase("idle");
    }
  });

  const phaseLabel = () => {
    if (phase === "preparing") return t("create.phasePreparing");
    if (phase === "signing") return t("trade.signing");
    if (phase === "confirming") return t("trade.confirming");
    return t("create.creating");
  };

  return (
    <PageShell>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        {/* ------------------------------------------------------------ form */}
        <div className="min-w-0 space-y-6">
          <header>
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t("create.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("create.subtitle")}</p>
            {(config?.vanityAvailable ?? 0) > 0 && (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                {t("create.vanityBadge")}
              </span>
            )}
          </header>

          <EarnBanner />

          {!authLoading && !canLaunch && (
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
                {!user ? t("nav.login") : t("trade.connectWallet")}
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

            {/* Initial buy + curve facts */}
            <section className="space-y-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="coin-initial-buy" className="text-sm font-semibold">
                    {t("create.initialBuy")}
                  </Label>
                  {walletLinked && (
                    <span className="inline-flex items-center gap-1 text-xs tabular text-muted-foreground">
                      <Wallet className="h-3 w-3" />
                      {t("trade.balance")}: <span className="font-semibold text-foreground">{fmtSol(balanceSol)} SOL</span>
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Input
                    id="coin-initial-buy"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={initialBuyRaw}
                    disabled={submitting}
                    onChange={(e) => setInitialBuy(e.target.value)}
                    aria-invalid={buyTooLarge || buyTooLargeForCap}
                    className={cn("h-11 rounded-lg pr-14 tabular", (buyTooLarge || buyTooLargeForCap) && "border-destructive focus-visible:ring-destructive")}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">SOL</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[0.1, 0.5, 1].map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={submitting}
                      onClick={() => setInitialBuy(String(v))}
                      className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-semibold tabular text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {v} SOL
                    </button>
                  ))}
                  {walletLinked && spendableSol > 0 && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setInitialBuy(String(Math.min(spendableSol, MAX_INITIAL_BUY_SOL)))}
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
                    {t("create.insufficient", { balance: `${fmtSol(balanceSol)} SOL` })}
                  </p>
                ) : buyTooLargeForCap ? (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {t("create.initialBuyMax", { max: `${MAX_INITIAL_BUY_SOL} SOL` })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("create.initialBuyHint")}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3 sm:grid-cols-3">
                <Stat label={t("create.launchMcap")} value={fmtCompactUsd(config?.launchMcapUsd ?? LAUNCH_MCAP_USD)} />
                <Stat label={t("create.graduationMcap")} value={fmtCompactUsd(config?.graduationMcapUsd ?? GRADUATION_MCAP_USD)} />
                <Stat label={t("create.creatorShare")} value={`${Math.round((config?.creatorFeeShare ?? CREATOR_FEE_SHARE) * 100)}%`} />
              </div>

              <p className="text-xs text-muted-foreground">
                {t("create.feeNotice", {
                  fee: `${((config?.swapFee ?? SWAP_FEE) * 100).toFixed(1)}%`,
                  share: `${Math.round((config?.creatorFeeShare ?? CREATOR_FEE_SHARE) * 100)}%`,
                })}
              </p>
            </section>

            <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
              <Button asChild type="button" variant="ghost" className="rounded-lg">
                <Link href="/">{t("common.cancel")}</Link>
              </Button>
              {canLaunch ? (
                <Button
                  type="submit"
                  size="lg"
                  disabled={submitting || buyTooLarge || buyTooLargeForCap}
                  className="h-12 rounded-xl px-6 text-base font-bold shadow-[0_0_24px_-6px_hsl(var(--primary)/0.9)]"
                >
                  {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Rocket className="h-5 w-5" />}
                  {submitting ? phaseLabel() : t("create.submit")}
                </Button>
              ) : (
                <Button type="button" size="lg" onClick={openLogin} disabled={authLoading} className="h-12 rounded-xl px-6 text-base font-bold">
                  <Lock className="h-4 w-4" />
                  {!user ? t("create.loginRequired") : t("trade.connectWallet")}
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
            <PreviewCard name={name} ticker={ticker} description={description} image={image} />
          </div>
          {initialBuySol > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-3 py-1">
                <span>{t("create.initialBuy")}</span>
                <span className="font-semibold tabular text-primary">{fmtSol(initialBuySol)} SOL</span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-bold tabular">{value}</div>
    </div>
  );
}
