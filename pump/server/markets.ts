/**
 * GeckoTerminal client — the tokens Next lists from chains other than Solana.
 *
 * Jupiter answers for Solana (server/jupiter.ts); everything else (Ethereum,
 * Base, BNB Chain, Monad, Hyperliquid, Robinhood) comes from GeckoTerminal's
 * public API, which covers the same three jobs: what is trending, one token's
 * numbers, and real OHLCV candles for its deepest pool.
 *
 * The same rule as the Jupiter client applies here: nothing in this module ever
 * throws on a network problem. A chain that is unreachable — or that the API
 * does not cover yet — degrades to an empty list, never to a 500. The free tier
 * allows roughly 30 calls a minute, so every response is cached and lists are
 * shared between callers.
 *
 * Trading is deliberately out of scope: these tokens are marked `tradable:
 * false` and the UI says so, rather than offering a swap Next cannot execute.
 */
import { z } from "zod";
import {
  CHAIN_LABELS,
  tokenId,
  type Candle,
  type Chain,
  type ExternalStatus,
  type ExternalToken,
} from "@shared/schema";
import { log } from "./vite";

const API_BASE = "https://api.geckoterminal.com/api/v2";
const TIMEOUT_MS = 10_000;
const LIST_TTL_MS = 60_000;
const TOKEN_TTL_MS = 30_000;
const CANDLES_TTL_MS = 120_000;
const LOG_THROTTLE_MS = 60_000;

/**
 * GeckoTerminal's own network ids. A chain the API does not know yet simply
 * returns nothing — which is why an unknown id here is harmless.
 */
const NETWORK_IDS: Record<Chain, string> = {
  // Solana's listings come from Jupiter, but its OHLCV comes from here — the
  // aggregator has no candle endpoint on the free tier.
  solana: "solana",
  ethereum: "eth",
  base: "base",
  bsc: "bsc",
  monad: "monad",
  hyperliquid: "hyperevm",
  robinhood: "robinhood",
};

export type MarketList = "trending" | "top" | "new";

// ---------------------------------------------------------------------------
// Availability, cache and fetch (same shape as the Jupiter client)
// ---------------------------------------------------------------------------

let lastOkAt: number | null = null;
let lastError: string | null = null;
const lastLoggedAt = new Map<string, number>();

export function marketsStatus(): ExternalStatus {
  return {
    available: lastOkAt !== null && Date.now() - lastOkAt < 5 * 60_000,
    lastOkAt: lastOkAt === null ? null : new Date(lastOkAt).toISOString(),
    lastError,
  };
}

function noteFailure(label: string, err: unknown): null {
  const message = err instanceof Error ? err.message : String(err);
  lastError = message;
  const now = Date.now();
  if (now - (lastLoggedAt.get(label) ?? 0) >= LOG_THROTTLE_MS) {
    lastLoggedAt.set(label, now);
    log(`${label} unavailable: ${message}`, "markets");
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

function cacheSet(key: string, value: unknown): void {
  if (cache.size > 400) {
    const oldest = Array.from(cache.entries())
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, 80);
    for (const [key] of oldest) cache.delete(key);
  }
  cache.set(key, { at: Date.now(), value });
}

export function clearMarketsCache(): void {
  cache.clear();
}

async function getJson(path: string, ttlMs: number, label: string): Promise<unknown | null> {
  const target = `${API_BASE}${path}`;
  const cached = cacheGet(target, ttlMs);
  if (cached !== undefined) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(target, {
        headers: { accept: "application/json;version=20230302" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    lastOkAt = Date.now();
    lastError = null;
    if (ttlMs > 0) cacheSet(target, json);
    return json;
  } catch (err) {
    return noteFailure(label, err);
  }
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields we use; everything else is ignored)
// ---------------------------------------------------------------------------

const num = z.union([z.number(), z.string()]).optional().nullable();

const poolSchema = z.object({
  id: z.string(),
  attributes: z
    .object({
      name: z.string().optional(),
      address: z.string().optional(),
      base_token_price_usd: num,
      fdv_usd: num,
      market_cap_usd: num,
      reserve_in_usd: num,
      pool_created_at: z.string().optional().nullable(),
      volume_usd: z.object({ h24: num }).partial().optional(),
      price_change_percentage: z.object({ h24: num }).partial().optional(),
      transactions: z
        .object({ h24: z.object({ buys: num, sells: num }).partial().optional() })
        .partial()
        .optional(),
    })
    .partial(),
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }).partial() }).partial().optional(),
      dex: z.object({ data: z.object({ id: z.string() }).partial() }).partial().optional(),
    })
    .partial()
    .optional(),
});

const includedTokenSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  attributes: z
    .object({
      address: z.string().optional(),
      name: z.string().optional(),
      symbol: z.string().optional(),
      image_url: z.string().optional().nullable(),
      decimals: num,
      total_supply: num,
      price_usd: num,
      fdv_usd: num,
      market_cap_usd: num,
      volume_usd: z.object({ h24: num }).partial().optional(),
    })
    .partial(),
});

const listResponseSchema = z.object({
  data: z.array(poolSchema).optional(),
  included: z.array(includedTokenSchema).optional(),
});

const tokenResponseSchema = z.object({
  data: includedTokenSchema.optional(),
  included: z.array(poolSchema).optional(),
});

const ohlcvRow = z.array(z.union([z.number(), z.string(), z.null()]));
/** Tolerates both the documented envelope and a bare list, so a shape change degrades rather than breaks. */
const ohlcvSchema = z.union([
  z.object({ data: z.object({ attributes: z.object({ ohlcv_list: z.array(ohlcvRow) }).partial() }).partial() }),
  z.object({ ohlcv_list: z.array(ohlcvRow) }),
]);

function finite(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type Pool = z.infer<typeof poolSchema>;
type IncludedToken = z.infer<typeof includedTokenSchema>;

/**
 * A pool plus the base token it trades describe one row in the feed. Numbers
 * come from whichever side reports them — the token entry knows the supply, the
 * pool knows the volume — and anything missing stays zero rather than NaN.
 */
function toToken(chain: Chain, pool: Pool, token: IncludedToken | undefined): ExternalToken | null {
  const address = token?.attributes.address ?? "";
  if (!address) return null;
  const attrs = pool.attributes;
  const priceUsd = finite(token?.attributes.price_usd ?? attrs.base_token_price_usd);
  const marketCapUsd = finite(
    token?.attributes.market_cap_usd ?? attrs.market_cap_usd ?? token?.attributes.fdv_usd ?? attrs.fdv_usd,
  );
  const symbol = (token?.attributes.symbol ?? "").trim().toUpperCase();

  return {
    id: tokenId(chain, address),
    chain,
    mint: address,
    name: (token?.attributes.name ?? (symbol || address)).trim(),
    symbol: symbol || "???",
    icon: normaliseIcon(token?.attributes.image_url),
    decimals: Math.max(0, Math.min(18, Math.round(finite(token?.attributes.decimals, 18)))),
    priceUsd,
    marketCapUsd,
    liquidityUsd: finite(attrs.reserve_in_usd),
    // The API reports a percentage; the UI works in fractions.
    change24h: finite(attrs.price_change_percentage?.h24) / 100,
    volume24hUsd: finite(token?.attributes.volume_usd?.h24 ?? attrs.volume_usd?.h24),
    holders: 0,
    verified: false,
    createdAt: attrs.pool_created_at ?? null,
    source: "geckoterminal",
    // Next executes swaps on Solana only, for now.
    tradable: false,
  };
}

/** GeckoTerminal serves "missing.png" placeholders; treat those as no icon. */
function normaliseIcon(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || v === "missing.png" || v.endsWith("/missing.png")) return null;
  return v;
}

/** Pools come with their tokens in `included`, keyed by the relationship id. */
function tokensById(included: IncludedToken[] | undefined): Map<string, IncludedToken> {
  const map = new Map<string, IncludedToken>();
  for (const entry of included ?? []) map.set(entry.id, entry);
  return map;
}

function mapPools(chain: Chain, json: unknown): ExternalToken[] {
  const parsed = listResponseSchema.safeParse(json);
  if (!parsed.success) return [];
  const byId = tokensById(parsed.data.included);
  const out: ExternalToken[] = [];
  const seen = new Set<string>();
  for (const pool of parsed.data.data ?? []) {
    const baseId = pool.relationships?.base_token?.data?.id;
    const token = baseId ? byId.get(baseId) : undefined;
    const mapped = toToken(chain, pool, token);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function supportsChain(chain: Chain): boolean {
  return chain in NETWORK_IDS;
}

const LIST_PATHS: Record<MarketList, (net: string) => string> = {
  trending: (net) => `/networks/${net}/trending_pools?include=base_token&page=1`,
  top: (net) => `/networks/${net}/pools?include=base_token&page=1&sort=h24_volume_usd_desc`,
  new: (net) => `/networks/${net}/new_pools?include=base_token&page=1`,
};

/** The list behind a chain's feed. Empty when the chain or the API is unavailable. */
export async function listTokens(chain: Chain, list: MarketList, limit = 40): Promise<ExternalToken[]> {
  if (!supportsChain(chain)) return [];
  const net = NETWORK_IDS[chain];
  const json = await getJson(LIST_PATHS[list](net), LIST_TTL_MS, `${CHAIN_LABELS[chain]} ${list}`);
  if (!json) return [];
  return mapPools(chain, json).slice(0, limit);
}

/** Search a chain for a token by name, symbol or address. */
export async function searchTokens(chain: Chain, query: string, limit = 20): Promise<ExternalToken[]> {
  if (!supportsChain(chain) || !query.trim()) return [];
  const net = NETWORK_IDS[chain];
  const json = await getJson(
    `/search/pools?query=${encodeURIComponent(query.trim())}&network=${net}&include=base_token&page=1`,
    LIST_TTL_MS,
    `${CHAIN_LABELS[chain]} search`,
  );
  if (!json) return [];
  return mapPools(chain, json).slice(0, limit);
}

/** One token plus its deepest pool, which is what the detail page charts. */
export async function getToken(
  chain: Chain,
  address: string,
): Promise<{ token: ExternalToken; pool: { address: string; dex: string | null } | null; pools: string[] } | null> {
  if (!supportsChain(chain)) return null;
  const net = NETWORK_IDS[chain];
  const json = await getJson(
    `/networks/${net}/tokens/${encodeURIComponent(address)}?include=top_pools`,
    TOKEN_TTL_MS,
    `${CHAIN_LABELS[chain]} token`,
  );
  if (!json) return null;
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success || !parsed.data.data) return null;

  const pool = parsed.data.included?.[0];
  const token = pool
    ? toToken(chain, pool, parsed.data.data)
    : toToken(chain, { id: "", attributes: {} }, parsed.data.data);
  if (!token) return null;
  // Every pool the token trades in, deepest first: the top one is sometimes dry.
  const pools = (parsed.data.included ?? [])
    .map((p) => p.attributes.address ?? p.id.split("_").slice(1).join("_"))
    .filter((a): a is string => !!a);
  const poolAddress = pools[0] ?? null;
  return {
    token,
    pool: poolAddress ? { address: poolAddress, dex: pool?.relationships?.dex?.data?.id ?? null } : null,
    pools,
  };
}

/** Real OHLCV for a pool, newest last, in USD per token. */
export async function getCandles(chain: Chain, poolAddress: string, minutes = 1, limit = 300): Promise<Candle[]> {
  if (!supportsChain(chain)) return [];
  const net = NETWORK_IDS[chain];
  // The API exposes minute/hour/day buckets with an aggregate multiplier.
  const timeframe = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute";
  const aggregate = timeframe === "day" ? Math.round(minutes / 1440) : timeframe === "hour" ? Math.round(minutes / 60) : minutes;
  const json = await getJson(
    `/networks/${net}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${timeframe}?aggregate=${Math.max(1, aggregate)}&limit=${limit}&currency=usd`,
    CANDLES_TTL_MS,
    `${CHAIN_LABELS[chain]} candles`,
  );
  if (!json) return [];
  const parsed = ohlcvSchema.safeParse(json);
  if (!parsed.success) return [];
  const rows = "ohlcv_list" in parsed.data ? parsed.data.ohlcv_list : (parsed.data.data?.attributes?.ohlcv_list ?? []);
  const candles: Candle[] = [];
  for (const row of rows) {
    const [ts, o, h, l, c, v] = row;
    const t = finite(ts) * 1000;
    const close = finite(c);
    if (!t || close <= 0) continue;
    candles.push({ t, o: finite(o, close), h: finite(h, close), l: finite(l, close), c: close, v: finite(v) });
  }
  return candles.sort((a, b) => a.t - b.t);
}

/** Candles from the first of `pools` that has any — a token's top pool is sometimes dry. */
export async function firstCandles(chain: Chain, pools: string[], max = 3): Promise<Candle[]> {
  for (const pool of pools.slice(0, max)) {
    const candles = await getCandles(chain, pool);
    if (candles.length > 0) return candles;
  }
  return [];
}
