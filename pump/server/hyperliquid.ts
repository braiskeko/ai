/**
 * Hyperliquid client — the perpetual markets Next lists.
 *
 * One public endpoint does the whole job: `POST /info` with
 * `{"type":"metaAndAssetCtxs"}` returns the universe (every market, its size
 * decimals and its maximum leverage) alongside a context array in the same
 * order (mark price, yesterday's price, 24 h notional volume, open interest,
 * funding). Pairing them by index is the entire mapping.
 *
 * Like the other market clients, nothing here throws on a network problem: the
 * list degrades to empty rather than failing the request, and responses are
 * cached because the feed polls.
 *
 * This module reads. Placing orders is a separate, signed flow (EIP-712 through
 * the account's own EVM key) and deliberately not part of it.
 */
import { z } from "zod";
import type { ExternalStatus, PerpMarket } from "@shared/schema";
import { log } from "./vite";

const API_URL = "https://api.hyperliquid.xyz/info";
const TIMEOUT_MS = 10_000;
const TTL_MS = 20_000;
const LOG_THROTTLE_MS = 60_000;

let lastOkAt: number | null = null;
let lastError: string | null = null;
let lastLoggedAt = 0;
let cached: { at: number; value: PerpMarket[] } | null = null;

export function hyperliquidStatus(): ExternalStatus {
  return {
    available: lastOkAt !== null && Date.now() - lastOkAt < 5 * 60_000,
    lastOkAt: lastOkAt === null ? null : new Date(lastOkAt).toISOString(),
    lastError,
  };
}

const numeric = z.union([z.number(), z.string()]).nullable().optional();

const metaAndCtxSchema = z.tuple([
  z.object({
    universe: z.array(
      z.object({
        name: z.string(),
        szDecimals: z.number().optional(),
        maxLeverage: z.number().optional(),
        onlyIsolated: z.boolean().optional(),
        isDelisted: z.boolean().optional(),
      }),
    ),
  }),
  z.array(
    z.object({
      markPx: numeric,
      midPx: numeric,
      oraclePx: numeric,
      prevDayPx: numeric,
      dayNtlVlm: numeric,
      openInterest: numeric,
      funding: numeric,
    }),
  ),
]);

function finite(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Hyperliquid lists more than crypto: markets deployed through HIP-3 cover
 * equities, commodities and indices. Their symbols carry a builder prefix, so
 * the category is read from the symbol rather than guessed from the name.
 */
const STOCK_SYMBOLS = new Set(["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "GOOGL", "COIN", "HOOD", "MSTR", "SPX", "QQQ"]);
const COMMODITY_SYMBOLS = new Set(["XAU", "XAG", "GOLD", "SILVER", "OIL", "WTI", "BRENT", "NGAS"]);
const INDEX_SYMBOLS = new Set(["SPX", "NDX", "DJI", "VIX", "US500", "NAS100"]);

function categoryOf(symbol: string): PerpMarket["category"] {
  const bare = symbol.replace(/^[a-z]+:/i, "").toUpperCase();
  if (COMMODITY_SYMBOLS.has(bare)) return "commodities";
  if (INDEX_SYMBOLS.has(bare)) return "indices";
  if (STOCK_SYMBOLS.has(bare)) return "stocks";
  return "crypto";
}

async function fetchMarkets(): Promise<PerpMarket[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = metaAndCtxSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("unexpected response shape");

    const [meta, contexts] = parsed.data;
    const markets: PerpMarket[] = [];
    meta.universe.forEach((asset, i) => {
      if (asset.isDelisted) return;
      const ctx = contexts[i];
      if (!ctx) return;
      const price = finite(ctx.markPx ?? ctx.midPx ?? ctx.oraclePx);
      if (price <= 0) return;
      const prev = finite(ctx.prevDayPx, price);
      markets.push({
        symbol: asset.name,
        priceUsd: price,
        change24h: prev > 0 ? (price - prev) / prev : 0,
        volume24hUsd: finite(ctx.dayNtlVlm),
        openInterestUsd: finite(ctx.openInterest) * price,
        // Reported per 8 hours, as a fraction.
        fundingRate: finite(ctx.funding),
        maxLeverage: Math.max(1, Math.round(asset.maxLeverage ?? 1)),
        category: categoryOf(asset.name),
      });
    });
    markets.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    lastOkAt = Date.now();
    lastError = null;
    return markets;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    const now = Date.now();
    if (now - lastLoggedAt >= LOG_THROTTLE_MS) {
      lastLoggedAt = now;
      log(`perp markets unavailable: ${message}`, "hyperliquid");
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every listed perp, busiest first. Empty when Hyperliquid is unreachable. */
export async function listPerps(limit = 100): Promise<PerpMarket[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value.slice(0, limit);
  const fresh = await fetchMarkets();
  if (!fresh) return cached ? cached.value.slice(0, limit) : [];
  cached = { at: now, value: fresh };
  return fresh.slice(0, limit);
}

export function clearPerpCache(): void {
  cached = null;
}
