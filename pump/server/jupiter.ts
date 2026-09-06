/**
 * Jupiter aggregator client — everything Next knows about tokens it did NOT
 * launch itself.
 *
 * Three jobs:
 *   1. discovery  (`/tokens/v2/...`)  → the "Solana" feed and search
 *   2. quoting    (`/swap/v1/quote`)  → the trade panel's numbers
 *   3. swapping   (`/swap/v1/swap`)   → an UNSIGNED base64 VersionedTransaction
 *
 * Next stays non-custodial: this module never signs anything. The wallet signs
 * the transaction in the browser and `/api/tx/send` relays it (kind "jupswap").
 *
 * Nothing in here ever throws on a network problem. Jupiter is a third party we
 * do not control; when it is unreachable the feed must degrade to an empty list
 * with a visible "unavailable" state, never to a 500. Every fetch therefore
 * resolves to `null` on failure, logs at most once a minute, and flips the
 * status returned by `jupiterStatus()`.
 *
 * Units: everything leaving this module is a plain number in USD, in SOL or in
 * whole tokens. Base units only exist inside the quote/swap calls.
 */
import { z } from "zod";
import {
  CANDLE_INTERVAL_MS,
  SOL_MINT,
  type Candle,
  type ExternalStatus,
  tokenId,
  type ExternalToken,
  type TradeQuote,
} from "@shared/schema";
import { config } from "./config";
import { log } from "./vite";

/** SOL is always the quote side of an external trade. */
export const SOL_DECIMALS = 9;

const TIMEOUT_MS = 10_000;
/** Discovery lists move slowly; a 45 s cache keeps us far below any rate limit. */
const LIST_TTL_MS = 45_000;
/** Single-token lookups back the detail page, which polls. */
const TOKEN_TTL_MS = 30_000;
/** One log line per minute per failing endpoint, no matter how many callers hit it. */
const LOG_THROTTLE_MS = 60_000;

export type TokenList = "trending" | "top" | "new";

const LIST_PATHS: Record<TokenList, string> = {
  trending: "/tokens/v2/toporganicscore/24h",
  top: "/tokens/v2/toptraded/24h",
  new: "/tokens/v2/recent",
};

// ---------------------------------------------------------------------------
// Availability + tiny per-URL cache
// ---------------------------------------------------------------------------

let lastOkAt: number | null = null;
let lastError: string | null = null;
const lastLoggedAt = new Map<string, number>();

/** Whether the aggregator answered within the last few minutes. */
export function jupiterStatus(): ExternalStatus {
  return {
    available: lastOkAt !== null && Date.now() - lastOkAt < 5 * 60_000,
    lastOkAt: lastOkAt === null ? null : new Date(lastOkAt).toISOString(),
    lastError,
  };
}

function noteOk(): void {
  lastOkAt = Date.now();
  lastError = null;
}

function noteFailure(label: string, err: unknown): null {
  const message = err instanceof Error ? err.message : String(err);
  lastError = message;
  const now = Date.now();
  const previous = lastLoggedAt.get(label) ?? 0;
  if (now - previous >= LOG_THROTTLE_MS) {
    lastLoggedAt.set(label, now);
    log(`${label} unavailable: ${message}`, "jupiter");
  }
  return null;
}

interface CacheEntry {
  at: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string, ttlMs: number): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Keeps the cache from growing without bound when many mints are searched. */
function cacheSet(key: string, value: unknown): void {
  if (cache.size > 500) {
    const entries: { key: string; at: number }[] = [];
    cache.forEach((entry, k) => entries.push({ key: k, at: entry.at }));
    entries.sort((a, b) => a.at - b.at);
    for (const entry of entries.slice(0, 100)) cache.delete(entry.key);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Only for tests / a manual refresh: drops every cached response. */
export function clearJupiterCache(): void {
  cache.clear();
}

function url(path: string, query?: Record<string, string | number | undefined>): string {
  const target = new URL(`${config.jupiter.apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

/** GET + parse JSON. Resolves to null on any transport, status or parse error. */
async function getJson(target: string, ttlMs: number, label: string): Promise<unknown | null> {
  const cached = cacheGet(target, ttlMs);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(target, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    noteOk();
    if (ttlMs > 0) cacheSet(target, json);
    return json;
  } catch (err) {
    return noteFailure(label, err);
  }
}

/** POST + parse JSON. Resolves to null on any transport, status or parse error. */
async function postJson(target: string, body: unknown, label: string): Promise<unknown | null> {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    noteOk();
    return json;
  } catch (err) {
    return noteFailure(label, err);
  }
}

// ---------------------------------------------------------------------------
// Schemas — deliberately forgiving
//
// Jupiter's v2 shapes are not versioned per field: names come and go and
// numbers arrive as either JSON numbers or strings. Every optional field
// therefore carries `.catch(undefined)` so one odd value degrades that field
// instead of dropping the whole token, and unknown keys are stripped (zod's
// default). Only the mint itself is mandatory.
// ---------------------------------------------------------------------------

const jupNumber = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .refine((n) => Number.isFinite(n), "not a finite number")
  .optional()
  .catch(undefined);

const jupBool = z.boolean().optional().catch(undefined);
const jupString = z.string().optional().catch(undefined);

const jupStatsSchema = z
  .object({
    /** percent, not a fraction: 12.5 means +12.5% */
    priceChange: jupNumber,
    buyVolume: jupNumber,
    sellVolume: jupNumber,
    numBuys: jupNumber,
    numSells: jupNumber,
  })
  .optional()
  .catch(undefined);

const jupPoolSchema = z
  .object({
    id: jupString,
    dex: jupString,
    createdAt: jupString,
  })
  .optional()
  .catch(undefined);

const jupAuditSchema = z
  .object({
    mintAuthorityDisabled: jupBool,
    freezeAuthorityDisabled: jupBool,
    /** percent of supply held by the top holders */
    topHoldersPercentage: jupNumber,
  })
  .optional()
  .catch(undefined);

export const jupTokenSchema = z.object({
  id: z.string().min(32).max(44),
  name: jupString,
  symbol: jupString,
  icon: jupString,
  decimals: jupNumber,
  usdPrice: jupNumber,
  /** older payloads called it `price` */
  price: jupNumber,
  mcap: jupNumber,
  fdv: jupNumber,
  liquidity: jupNumber,
  holderCount: jupNumber,
  organicScore: jupNumber,
  isVerified: jupBool,
  website: jupString,
  twitter: jupString,
  telegram: jupString,
  stats24h: jupStatsSchema,
  firstPool: jupPoolSchema,
  audit: jupAuditSchema,
});

export type JupToken = z.infer<typeof jupTokenSchema>;

/** Extra detail fields kept alongside `ExternalToken` for the detail page. */
export interface JupTokenExtras {
  supply: number;
  organicScore: number;
  buys24h: number;
  sells24h: number;
  audit: { mintAuthorityDisabled: boolean | null; freezeAuthorityDisabled: boolean | null; topHoldersPercent: number | null };
  links: { website: string | null; twitter: string | null; telegram: string | null };
  pool: { id: string | null; dex: string | null; createdAt: string | null } | null;
}

const finite = (n: number | undefined, fallback = 0): number => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/** ISO string when the input parses as a date, null otherwise. */
function isoOrNull(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One raw list entry → the API's `ExternalToken`, or null when it is unusable
 * (no mint, or no price to trade against). Pure: unit-tested against a sample
 * payload in jupiter.test.ts.
 */
export function parseJupToken(raw: unknown): { token: ExternalToken; extras: JupTokenExtras } | null {
  const parsed = jupTokenSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;

  const priceUsd = finite(t.usdPrice ?? t.price);
  const stats = t.stats24h;
  const marketCapUsd = finite(t.mcap ?? t.fdv);
  const supply = priceUsd > 0 && marketCapUsd > 0 ? marketCapUsd / priceUsd : 0;
  const topHolders = stripUndefined(t.audit?.topHoldersPercentage);

  const token: ExternalToken = {
    id: tokenId("solana", t.id),
    chain: "solana",
    mint: t.id,
    name: (t.name ?? t.symbol ?? t.id).trim() || t.id,
    symbol: (t.symbol ?? "").trim().toUpperCase() || "???",
    icon: t.icon?.trim() || null,
    decimals: Math.max(0, Math.min(18, Math.round(finite(t.decimals, 6)))),
    priceUsd,
    marketCapUsd,
    liquidityUsd: finite(t.liquidity),
    // Jupiter reports the change in percent; the UI works in fractions.
    change24h: finite(stats?.priceChange) / 100,
    volume24hUsd: finite(stats?.buyVolume) + finite(stats?.sellVolume),
    holders: Math.max(0, Math.round(finite(t.holderCount))),
    verified: t.isVerified === true,
    tradable: true,
    createdAt: isoOrNull(t.firstPool?.createdAt),
    source: "jupiter",
  };

  const extras: JupTokenExtras = {
    supply,
    organicScore: finite(t.organicScore),
    buys24h: Math.max(0, Math.round(finite(stats?.numBuys))),
    sells24h: Math.max(0, Math.round(finite(stats?.numSells))),
    audit: {
      mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
      topHoldersPercent: topHolders === null ? null : topHolders / 100,
    },
    links: {
      website: t.website?.trim() || null,
      twitter: t.twitter?.trim() || null,
      telegram: t.telegram?.trim() || null,
    },
    pool: t.firstPool
      ? { id: t.firstPool.id ?? null, dex: t.firstPool.dex ?? null, createdAt: isoOrNull(t.firstPool.createdAt) }
      : null,
  };

  return { token, extras };
}

function stripUndefined(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The array inside a Jupiter response, whichever envelope it arrived in. */
export function asArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const key of ["tokens", "data", "results", "items"]) {
      const value = (json as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Parses a whole payload, skipping malformed entries and duplicate mints. */
export function parseJupTokens(json: unknown, limit = 50): ExternalToken[] {
  const out: ExternalToken[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(json)) {
    const parsed = parseJupToken(raw);
    if (!parsed || seen.has(parsed.token.mint)) continue;
    seen.add(parsed.token.mint);
    out.push(parsed.token);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** One of the curated lists. Empty array when Jupiter is unreachable. */
export async function listTokens(list: TokenList, limit = 50): Promise<ExternalToken[]> {
  const capped = Math.min(100, Math.max(1, Math.floor(limit)));
  const json = await getJson(url(LIST_PATHS[list], { limit: capped }), LIST_TTL_MS, `tokens/${list}`);
  return json === null ? [] : parseJupTokens(json, capped);
}

/** Free-text search over mint, symbol and name. Empty array when unreachable. */
export async function searchTokens(query: string, limit = 20): Promise<ExternalToken[]> {
  const q = query.trim();
  if (!q) return [];
  const capped = Math.min(100, Math.max(1, Math.floor(limit)));
  const json = await getJson(url("/tokens/v2/search", { query: q }), LIST_TTL_MS, "tokens/search");
  return json === null ? [] : parseJupTokens(json, capped);
}

/** A single mint, or null when unknown / unreachable. */
export async function getToken(mint: string): Promise<{ token: ExternalToken; extras: JupTokenExtras } | null> {
  const json = await getJson(url("/tokens/v2/search", { query: mint }), TOKEN_TTL_MS, "tokens/search");
  if (json === null) return null;
  for (const raw of asArray(json)) {
    const parsed = parseJupToken(raw);
    if (parsed && parsed.token.mint === mint) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Base-unit conversions (pure)
// ---------------------------------------------------------------------------

/**
 * Whole tokens → integer base-unit string. Done on the decimal string rather
 * than by multiplying, so 0.1 SOL is exactly "100000000" and not
 * "100000000.00000001".
 */
export function toBaseUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  const d = Math.max(0, Math.min(18, Math.floor(decimals)));
  const [int = "0", frac = ""] = amount.toFixed(d).split(".");
  const digits = `${int}${frac.padEnd(d, "0")}`.replace(/^0+(?=\d)/, "");
  return digits || "0";
}

/** Integer base units (string or number) → whole tokens. */
export function fromBaseUnits(units: string | number, decimals: number): number {
  const n = typeof units === "number" ? units : Number(units);
  if (!Number.isFinite(n)) return 0;
  const d = Math.max(0, Math.min(18, Math.floor(decimals)));
  return n / 10 ** d;
}

export const lamportsToSol = (lamports: string | number): number => fromBaseUnits(lamports, SOL_DECIMALS);

// ---------------------------------------------------------------------------
// Quoting & swapping
// ---------------------------------------------------------------------------

const jupQuoteSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.union([z.string(), z.number()]),
  outAmount: z.union([z.string(), z.number()]),
  otherAmountThreshold: z.union([z.string(), z.number()]).optional().catch(undefined),
  priceImpactPct: z.union([z.string(), z.number()]).optional().catch(undefined),
  slippageBps: jupNumber,
  platformFee: z
    .object({ amount: z.union([z.string(), z.number()]).optional().catch(undefined), feeBps: jupNumber })
    .nullable()
    .optional()
    .catch(undefined),
});

export interface JupQuote {
  /** The response verbatim — the swap endpoint requires the original object back. */
  raw: unknown;
  inputMint: string;
  outputMint: string;
  /** base units of the input mint */
  inAmount: number;
  /** base units of the output mint */
  outAmount: number;
  /** minimum output after slippage, base units of the output mint */
  minOutAmount: number;
  /** platform fee in output-mint base units (0 when no fee account is configured) */
  platformFeeAmount: number;
  /** price impact as a fraction (0.01 = 1%) */
  priceImpact: number;
}

const toNum = (v: string | number | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Shapes a raw quote response; null when it is not a usable quote. */
export function parseJupQuote(json: unknown): JupQuote | null {
  const parsed = jupQuoteSchema.safeParse(json);
  if (!parsed.success) return null;
  const q = parsed.data;
  const outAmount = toNum(q.outAmount);
  if (!(outAmount > 0)) return null;
  return {
    raw: json,
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount: toNum(q.inAmount),
    outAmount,
    minOutAmount: toNum(q.otherAmountThreshold, outAmount),
    platformFeeAmount: toNum(q.platformFee?.amount),
    priceImpact: Math.abs(toNum(q.priceImpactPct)),
  };
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** integer base units of the input mint */
  amount: string;
  slippageBps: number;
}

/** Prices a route. Null when Jupiter is unreachable or has no route. */
export async function getQuote(params: QuoteParams): Promise<JupQuote | null> {
  if (params.amount === "0") return null;
  const json = await getJson(
    url("/swap/v1/quote", {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: Math.max(0, Math.min(5000, Math.round(params.slippageBps))),
      restrictIntermediateTokens: "true",
      // A platform fee is only honoured when the swap call also passes feeAccount.
      ...(config.jupiter.feeAccount ? { platformFeeBps: config.jupiter.feeBps } : {}),
    }),
    // Quotes are per-user and time-sensitive: never served from the cache.
    0,
    "swap/quote",
  );
  return json === null ? null : parseJupQuote(json);
}

const jupSwapSchema = z.object({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: jupNumber,
});

export interface JupSwapTx {
  /** base64 **VersionedTransaction**, unsigned */
  swapTransaction: string;
  lastValidBlockHeight: number;
}

/**
 * The unsigned swap transaction for `userPublicKey`. Null when Jupiter is
 * unreachable or refuses the route.
 *
 * `wrapAndUnwrapSol` lets the user trade with native SOL (no wSOL account to
 * manage), and the priority-fee block keeps memecoin swaps landing during
 * congestion without ever exceeding 0.001 SOL.
 */
export async function buildSwapTx(params: { quote: JupQuote; userPublicKey: string }): Promise<JupSwapTx | null> {
  const feeAccount = config.jupiter.feeAccount;
  const body = {
    quoteResponse: params.quote.raw,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" },
    },
    ...(feeAccount ? { feeAccount } : {}),
  };
  const json = await postJson(url("/swap/v1/swap"), body, "swap/swap");
  if (json === null) return null;
  const parsed = jupSwapSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    swapTransaction: parsed.data.swapTransaction,
    lastValidBlockHeight: Math.max(0, Math.round(finite(parsed.data.lastValidBlockHeight))),
  };
}

// ---------------------------------------------------------------------------
// Quote → the API's TradeQuote (pure)
// ---------------------------------------------------------------------------

export interface ExternalQuoteParams {
  side: "buy" | "sell";
  quote: JupQuote;
  /** decimals of the traded token (SOL's 9 are implicit on the other side) */
  decimals: number;
  /** spot price of the token in USD, for the "before" price */
  priceUsd: number;
  /** circulating supply, for the resulting market cap (0 when unknown) */
  supply: number;
  /** SOL price in USD (from /api/config) */
  solUsd: number;
}

/**
 * Converts a Jupiter route into the same `TradeQuote` the bonding-curve panel
 * consumes, so the UI needs no second shape.
 *
 * Buys spend SOL for tokens, sells spend tokens for SOL — exactly like the
 * curve. `priceAfterSol` is the route's *effective* price (SOL in / tokens out),
 * which is what the user actually pays; `priceBeforeSol` is the token's spot
 * price converted through solUsd. `completesCurve` is always false: external
 * tokens have no curve to complete.
 */
export function toExternalTradeQuote(params: ExternalQuoteParams): TradeQuote {
  const { side, quote, decimals, priceUsd, supply, solUsd } = params;
  const buy = side === "buy";

  const solAmount = buy ? lamportsToSol(quote.inAmount) : lamportsToSol(quote.outAmount);
  const tokenAmount = buy ? fromBaseUnits(quote.outAmount, decimals) : fromBaseUnits(quote.inAmount, decimals);
  const minOut = buy ? fromBaseUnits(quote.minOutAmount, decimals) : lamportsToSol(quote.minOutAmount);

  // The platform fee is charged on the output mint: SOL when selling, tokens
  // when buying. Express it in SOL either way.
  const priceAfterSol = tokenAmount > 0 ? solAmount / tokenAmount : 0;
  const feeSol = buy
    ? fromBaseUnits(quote.platformFeeAmount, decimals) * priceAfterSol
    : lamportsToSol(quote.platformFeeAmount);

  const priceBeforeSol = solUsd > 0 && priceUsd > 0 ? priceUsd / solUsd : priceAfterSol;

  return {
    side,
    amountIn: buy ? solAmount : tokenAmount,
    amountOut: buy ? tokenAmount : solAmount,
    minOut,
    feeSol,
    priceBeforeSol,
    priceAfterSol,
    priceImpact: quote.priceImpact,
    marketCapAfterSol: supply > 0 ? supply * priceAfterSol : 0,
    completesCurve: false,
  };
}

// ---------------------------------------------------------------------------
// Price history → candles
//
// The free tier has no OHLC endpoint, so the server samples the price every
// time a token's detail page is fetched and derives 1-minute candles from that
// ring buffer. Nothing is persisted: a restart simply starts a new history.
// ---------------------------------------------------------------------------

/** Points kept per mint (~8 h at one sample per minute). */
export const PRICE_BUFFER_CAP = 500;
/** Mints nobody has looked at for an hour are dropped. */
const PRICE_TTL_MS = 60 * 60_000;

export interface PricePoint {
  /** ms since epoch */
  t: number;
  /** USD per token */
  price: number;
}

interface History {
  touchedAt: number;
  points: PricePoint[];
}

const histories = new Map<string, History>();

/**
 * Appends a price sample for `mint`. Samples that land in the same second as
 * the previous one replace it, so a burst of page loads cannot flood the
 * buffer.
 */
export function recordPrice(mint: string, price: number, at = Date.now()): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const history = histories.get(mint) ?? { touchedAt: at, points: [] };
  history.touchedAt = at;
  const last = history.points[history.points.length - 1];
  if (last && at - last.t < 1_000) {
    last.price = price;
  } else {
    history.points.push({ t: at, price });
    if (history.points.length > PRICE_BUFFER_CAP) {
      history.points.splice(0, history.points.length - PRICE_BUFFER_CAP);
    }
  }
  histories.set(mint, history);
  evictStaleHistories(at);
}

function evictStaleHistories(now: number): void {
  if (histories.size < 50) return;
  histories.forEach((history, mint) => {
    if (now - history.touchedAt >= PRICE_TTL_MS) histories.delete(mint);
  });
}

/** The samples recorded for a mint so far (oldest first). */
export function priceHistory(mint: string): PricePoint[] {
  return histories.get(mint)?.points ?? [];
}

export function clearPriceHistory(): void {
  histories.clear();
}

/**
 * Buckets price samples into OHLC candles (pure, unit-tested).
 *
 * `v` is always 0: we sample prices, not trades, so there is no volume to
 * report per bucket. Buckets with no sample are simply absent — the chart
 * already fills gaps with flat candles.
 */
export function derivePriceCandles(points: PricePoint[], intervalMs = CANDLE_INTERVAL_MS): Candle[] {
  const step = intervalMs > 0 ? intervalMs : CANDLE_INTERVAL_MS;
  const sorted = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price) && p.price > 0)
    .slice()
    .sort((a, b) => a.t - b.t);

  const out: Candle[] = [];
  for (const point of sorted) {
    const t = Math.floor(point.t / step) * step;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, point.price);
      last.l = Math.min(last.l, point.price);
      last.c = point.price;
    } else {
      out.push({ t, o: point.price, h: point.price, l: point.price, c: point.price, v: 0 });
    }
  }
  return out;
}

/** 1-minute candles derived from the samples recorded for `mint`. */
export function candlesFor(mint: string): Candle[] {
  return derivePriceCandles(priceHistory(mint));
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function jupiterSwapUrl(mint: string): string {
  return `https://jup.ag/swap/SOL-${mint}`;
}

export { SOL_MINT };
