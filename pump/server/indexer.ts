/**
 * Chain → storage indexer.
 *
 * Three things keep the database in sync with the Meteora pools launched
 * through Next's config:
 *
 *  1. `syncPools()` every 10 s — `getPoolsByConfig` gives every pool with its
 *     full account state, so one call refreshes every curve and discovers coins
 *     created outside our UI (someone can always use the config directly).
 *  2. A `onLogs` subscription per live pool — new signatures are decoded and
 *     recorded within a second of confirmation.
 *  3. `backfill()` on boot and `indexSignature()` from `/api/tx/send`, so a
 *     trade is already in the response the trader gets back.
 *
 * Swaps are decoded from the transaction's pre/post token balances rather than
 * from program logs: it needs no IDL, survives program upgrades and works the
 * same for the pool-creation transaction (which contains the creator's first
 * buy). `decodeSwap` is pure and unit-tested.
 *
 * The indexer never throws into the server: RPC failures flip `rpcOk` and are
 * retried with backoff.
 */
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { SWAP_FEE, TOKEN_DECIMALS, type AdminOverview, type Coin, type CoinSummary, type Trade } from "@shared/schema";
import { coinFieldsFromMetadata, mintFromMetadataUri, readTokenMetadata } from "./meta";
import {
  configPubkey,
  connection,
  curveStateFrom,
  getPoolConfig,
  listPools,
  poolAddressForMint,
  poolStateOf,
  readMintMetadata,
  readPoolState,
} from "./solana";
import { storage, type TradeSide } from "./storage";
import { log } from "./vite";

const SYNC_INTERVAL_MS = 10_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
/** getSignaturesForAddress returns at most 1000 per page. */
const SIGNATURE_PAGE = 1000;
/** Never walk further back than this on a first backfill of an unknown pool. */
const MAX_BACKFILL_PAGES = 5;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const LAMPORTS = 1_000_000_000;

// ---------------------------------------------------------------------------
// Broadcast seam (routes.ts owns the WebSocket; the indexer must not import it)
// ---------------------------------------------------------------------------

export type BroadcastFn = (event: string, payload: unknown) => void;

let broadcast: BroadcastFn = () => {};

export function setBroadcaster(fn: BroadcastFn): void {
  broadcast = fn;
}

// ---------------------------------------------------------------------------
// Pure decoding
// ---------------------------------------------------------------------------

export interface DecodedSwap {
  side: TradeSide;
  /** SOL paid (buy, fee included) or received (sell, net of fee) */
  sol: number;
  /** whole tokens received (buy) or sold (sell) */
  tokens: number;
  feeSol: number;
  /** curve price of this fill, in SOL per token */
  priceSol: number;
  wallet: string;
  slot: number;
  createdAt: string;
}

interface BalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

function amountOf(entries: readonly BalanceEntry[] | undefined, match: (e: BalanceEntry) => boolean): number | null {
  const found = entries?.find(match);
  if (!found) return null;
  const raw = Number(found.uiTokenAmount.amount);
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Turns a confirmed transaction into a swap, using the balance change of the
 * pool's quote vault (SOL side) and of the trader's own token account.
 *
 * Fees are collected in the quote token, stay inside the quote vault until
 * claimed and are therefore part of its balance change:
 *  - buy:  the vault gains everything the trader paid; the curve only receives
 *          `paid - fee`, so the fill price is `(paid - fee) / tokens`.
 *  - sell: the vault only pays out the trader's net, so the gross the curve
 *          gave back is `net / (1 - fee)`.
 *
 * Returns null when the transaction failed, touched no vault or moved no SOL.
 */
export function decodeSwap(
  tx: ParsedTransactionWithMeta,
  pool: { quoteVault: string; mint: string },
): DecodedSwap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const keys = tx.transaction.message.accountKeys;
  const vaultIndex = keys.findIndex((k) => k.pubkey.toBase58() === pool.quoteVault);
  if (vaultIndex === -1) return null;

  const pre = meta.preTokenBalances as readonly BalanceEntry[] | undefined;
  const post = meta.postTokenBalances as readonly BalanceEntry[] | undefined;

  const vaultBefore = amountOf(pre, (e) => e.accountIndex === vaultIndex) ?? 0;
  const vaultAfter = amountOf(post, (e) => e.accountIndex === vaultIndex);
  if (vaultAfter === null) return null;

  const vaultDelta = vaultAfter - vaultBefore;
  if (vaultDelta === 0) return null;

  const signer = keys.find((k) => k.signer)?.pubkey.toBase58() ?? keys[0]?.pubkey.toBase58();
  if (!signer) return null;

  const isTraderAccount = (e: BalanceEntry): boolean => e.mint === pool.mint && e.owner === signer;
  const tokensBefore = amountOf(pre, isTraderAccount) ?? 0;
  const tokensAfter = amountOf(post, isTraderAccount);
  if (tokensAfter === null) return null;
  const tokens = Math.abs(tokensAfter - tokensBefore) / TOKEN_UNIT;
  if (tokens <= 0) return null;

  const buy = vaultDelta > 0;
  const sol = Math.abs(vaultDelta) / LAMPORTS;
  const feeSol = buy ? sol * SWAP_FEE : (sol * SWAP_FEE) / (1 - SWAP_FEE);
  const curveSol = buy ? sol - feeSol : sol + feeSol;

  return {
    side: buy ? "buy" : "sell",
    sol,
    tokens,
    feeSol,
    priceSol: tokens > 0 ? curveSol / tokens : 0,
    wallet: signer,
    slot: tx.slot,
    createdAt: new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Indexer state
// ---------------------------------------------------------------------------

interface Subscription {
  pool: string;
  id: number;
}

let syncTimer: NodeJS.Timeout | null = null;
let running = false;
let syncing = false;
let backoffMs = BACKOFF_MIN_MS;
const subscriptions = new Map<string, Subscription>();

let lastSlot = 0;
let lastSyncAt: string | null = null;
let rpcOk = false;

export function status(): AdminOverview["indexer"] {
  return { lastSlot, lastSyncAt, subscribedPools: subscriptions.size, rpcOk };
}

function summaryOf(coin: Coin): CoinSummary {
  return storage.summarize(coin);
}

// ---------------------------------------------------------------------------
// Pool discovery / curve refresh
// ---------------------------------------------------------------------------

/** Name/symbol/uri from the mint's metadata account, merged with our own JSON. */
async function metadataFor(mint: string): Promise<{
  name: string;
  ticker: string;
  metadataUri: string;
  description?: string;
  imageUrl?: string;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
}> {
  let name = "";
  let ticker = "";
  let metadataUri = "";
  try {
    const onChain = await readMintMetadata(mint);
    if (onChain) {
      name = onChain.name;
      ticker = onChain.symbol;
      metadataUri = onChain.uri;
    }
  } catch (err) {
    log(`metadata read failed for ${mint}: ${(err as Error).message}`, "indexer");
  }

  // Only trust a local file when the uri actually points back at us.
  if (metadataUri && mintFromMetadataUri(metadataUri) === mint) {
    const local = await readTokenMetadata(mint);
    if (local) {
      return {
        name: name || local.name,
        ticker: ticker || local.symbol,
        metadataUri,
        ...coinFieldsFromMetadata(local),
      };
    }
  }
  return { name, ticker, metadataUri };
}

/** Reads one pool and upserts the coin behind it. Returns the stored coin. */
export async function indexPool(address: PublicKey | string): Promise<Coin | null> {
  const read = await readPoolState(address);
  if (!read) return null;
  const state = poolStateOf(read.pool);
  const mint = state.baseMint.toBase58();
  const poolAddress = typeof address === "string" ? address : address.toBase58();

  const known = storage.findCoinByCa(mint);
  const meta = known ? { name: known.name, ticker: known.ticker, metadataUri: known.metadataUri } : await metadataFor(mint);

  const { coin, created } = storage.upsertCoinFromChain({
    ca: mint,
    pool: poolAddress,
    name: meta.name,
    ticker: meta.ticker,
    metadataUri: meta.metadataUri,
    creatorWallet: state.creator.toBase58(),
    curve: read.curve,
    ...("description" in meta ? meta : {}),
  });
  if (created) broadcast("coin:created", { coin: summaryOf(coin) });
  return coin;
}

/** Finds (and indexes) the pool of a mint launched through our config. */
export async function indexPoolForMint(mint: string): Promise<Coin | null> {
  if (!configPubkey) return null;
  try {
    return await indexPool(poolAddressForMint(mint));
  } catch (err) {
    log(`indexing pool for mint ${mint} failed: ${(err as Error).message}`, "indexer");
    return null;
  }
}

/**
 * Refreshes every pool of our config in a single RPC call and broadcasts what
 * changed. New pools are added as coins, completed curves emit `coin:graduated`.
 */
export async function syncPools(): Promise<void> {
  if (!configPubkey || syncing) return;
  syncing = true;
  try {
    const pools = await listPools();
    const slot = await connection.getSlot("confirmed").catch(() => lastSlot);
    for (const { address, pool } of pools) {
      const state = poolStateOf(pool);
      const mint = state.baseMint.toBase58();
      const poolAddress = address.toBase58();
      const poolConfig = await getPoolConfig(state.config);
      const curve = curveStateFrom(pool, poolConfig, slot);

      const existing = storage.findCoinByCa(mint);
      if (!existing) {
        const meta = await metadataFor(mint);
        const { coin, created } = storage.upsertCoinFromChain({
          ca: mint,
          pool: poolAddress,
          name: meta.name,
          ticker: meta.ticker,
          metadataUri: meta.metadataUri,
          creatorWallet: state.creator.toBase58(),
          curve,
          description: meta.description,
          imageUrl: meta.imageUrl,
          website: meta.website,
          twitter: meta.twitter,
          telegram: meta.telegram,
        });
        if (created) broadcast("coin:created", { coin: summaryOf(coin) });
        await backfillPool(coin);
        subscribe(coin);
        continue;
      }

      const before = existing.curve;
      const graduated = storage.setCurve(existing, curve);
      if (graduated) {
        broadcast("coin:graduated", { coin: summaryOf(existing) });
        unsubscribe(existing.pool);
      } else if (before.priceSol !== curve.priceSol || before.quoteReserveSol !== curve.quoteReserveSol) {
        broadcast("coin:updated", { coin: summaryOf(existing) });
      }
      if (!curve.migrated) subscribe(existing);
      else unsubscribe(existing.pool);
    }
    lastSlot = slot;
    lastSyncAt = new Date().toISOString();
    rpcOk = true;
    backoffMs = BACKOFF_MIN_MS;
  } catch (err) {
    rpcOk = false;
    log(`pool sync failed: ${(err as Error).message}`, "indexer");
    backoffMs = Math.min(BACKOFF_MAX_MS, Math.round(backoffMs * 1.8));
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Trade ingestion
// ---------------------------------------------------------------------------

/**
 * Decodes and records one transaction. Returns the trade when it was a swap we
 * had not seen yet, null otherwise (already indexed, not a swap, failed tx).
 */
export async function indexSignature(signature: string, coinHint?: Coin): Promise<Trade | null> {
  if (storage.hasSignature(signature)) return null;
  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  } catch (err) {
    log(`fetching ${signature} failed: ${(err as Error).message}`, "indexer");
    return null;
  }
  if (!tx) return null;

  // Which of our pools does this transaction touch?
  const coin = coinHint ?? findCoinInTx(tx);
  if (!coin) return null;

  const read = await readPoolState(coin.pool).catch(() => null);
  const quoteVault = read ? poolStateOf(read.pool).quoteVault.toBase58() : null;
  if (!quoteVault) return null;

  const swap = decodeSwap(tx, { quoteVault, mint: coin.ca });
  if (!swap) return null;

  const recorded = storage.recordTrade({
    coinId: coin.id,
    signature,
    wallet: swap.wallet,
    side: swap.side,
    sol: swap.sol,
    tokens: swap.tokens,
    feeSol: swap.feeSol,
    priceSol: swap.priceSol,
    slot: swap.slot,
    createdAt: swap.createdAt,
  });
  if (!recorded) return null;

  if (read) storage.setCurve(coin, read.curve);
  if (!coin.createdTx) {
    // The oldest signature of a pool is its creation transaction.
    const created = storage.findCoinByCa(coin.ca);
    if (created && !created.createdTx) created.createdTx = signature;
  }

  const summary = summaryOf(recorded.coin);
  broadcast("trade", { trade: { ...recorded.trade, user: storage.toPublicUser(recorded.trade.userId) }, coin: summary });
  return recorded.trade;
}

/** The coin whose pool address appears in the transaction, if any. */
function findCoinInTx(tx: ParsedTransactionWithMeta): Coin | undefined {
  for (const key of tx.transaction.message.accountKeys) {
    const coin = storage.findCoinByPool(key.pubkey.toBase58());
    if (coin) return coin;
  }
  return undefined;
}

/** Indexes every signature of a pool we have not seen yet, oldest first. */
export async function backfillPool(coin: Coin): Promise<number> {
  const until = storage.getCursor(coin.pool);
  const address = new PublicKey(coin.pool);
  const collected: string[] = [];
  let before: string | undefined;

  try {
    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
      const batch = await connection.getSignaturesForAddress(address, { before, until, limit: SIGNATURE_PAGE }, "confirmed");
      if (batch.length === 0) break;
      for (const entry of batch) if (!entry.err) collected.push(entry.signature);
      before = batch[batch.length - 1].signature;
      if (batch.length < SIGNATURE_PAGE) break;
      // Without a cursor we would walk the whole history of a busy pool.
      if (!until) break;
    }
  } catch (err) {
    rpcOk = false;
    log(`backfill of ${coin.ticker || coin.ca} failed: ${(err as Error).message}`, "indexer");
    return 0;
  }

  let indexed = 0;
  // getSignaturesForAddress returns newest first; replay in chronological order.
  for (const signature of collected.reverse()) {
    const trade = await indexSignature(signature, coin);
    if (trade) indexed++;
  }
  if (collected.length > 0) storage.setCursor(coin.pool, collected[collected.length - 1]);
  return indexed;
}

// ---------------------------------------------------------------------------
// Log subscriptions
// ---------------------------------------------------------------------------

function subscribe(coin: Coin): void {
  if (!coin.pool || subscriptions.has(coin.pool) || coin.curve.migrated) return;
  try {
    const id = connection.onLogs(
      new PublicKey(coin.pool),
      (logs) => {
        if (logs.err) return;
        void indexSignature(logs.signature).catch((err) =>
          log(`indexing ${logs.signature} failed: ${(err as Error).message}`, "indexer"),
        );
      },
      "confirmed",
    );
    subscriptions.set(coin.pool, { pool: coin.pool, id });
  } catch (err) {
    log(`subscribing to ${coin.pool} failed: ${(err as Error).message}`, "indexer");
  }
}

function unsubscribe(pool: string): void {
  const sub = subscriptions.get(pool);
  if (!sub) return;
  subscriptions.delete(pool);
  void connection.removeOnLogsListener(sub.id).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts the indexer: one sync (which discovers pools, refreshes curves and
 * subscribes), then one every 10 s. Backfilling the trade history of every known
 * pool can take a while, so it runs in the background — the HTTP server must not
 * wait for it. Never rejects: a dead RPC only sets `rpcOk = false`.
 */
export async function start(): Promise<void> {
  if (running) return;
  running = true;
  if (!configPubkey) {
    log("DBC_CONFIG is not set: the indexer stays idle and launching is disabled", "indexer");
    return;
  }
  await syncPools();
  void backfillAll();
  scheduleSync();
}

/** Replays the missing signatures of every live pool, oldest first. */
async function backfillAll(): Promise<void> {
  for (const summary of storage.listCoins({ limit: Number.MAX_SAFE_INTEGER })) {
    const coin = storage.findCoinByCa(summary.ca);
    if (!coin || coin.curve.migrated) continue;
    try {
      const indexed = await backfillPool(coin);
      if (indexed) log(`backfilled ${indexed} trades for ${coin.ticker || coin.ca}`, "indexer");
    } catch (err) {
      log(`backfill of ${coin.ca} failed: ${(err as Error).message}`, "indexer");
    }
  }
}

function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  const delay = rpcOk ? SYNC_INTERVAL_MS : backoffMs;
  syncTimer = setTimeout(() => {
    void syncPools().finally(() => {
      if (running) scheduleSync();
    });
  }, delay);
  syncTimer.unref();
}

export function stop(): void {
  running = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  for (const pool of Array.from(subscriptions.keys())) unsubscribe(pool);
}
