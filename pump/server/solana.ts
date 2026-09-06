/**
 * Every piece of Solana / Meteora Dynamic Bonding Curve knowledge lives here.
 *
 * Next is non-custodial: this module only ever *reads* the chain and *builds*
 * unsigned transactions. The user's wallet signs them in the browser and posts
 * the signed bytes back to `/api/tx/send`, which relays them through
 * `sendSignedTx`. The only key material the server may hold is a pre-mined
 * vanity mint keypair, which co-signs pool creation (see vanity.ts).
 *
 * Units: everything that crosses the HTTP boundary is a plain number in SOL or
 * in whole tokens. On-chain math uses BN in lamports (9 dp) / token base units
 * (6 dp); the conversions live at the bottom of this file and are unit-tested.
 */
import { Connection, Keypair, PublicKey, Transaction, type ParsedAccountData } from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  TokenDecimal,
  U64_MAX,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  deriveMintMetadata,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAMPORTS_PER_SOL, TOKEN_DECIMALS, TOTAL_SUPPLY, type ClusterInfo, type CurveState, type TradeQuote } from "@shared/schema";
import { config } from "./config";
import { log } from "./vite";

export { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcPoolAddress, deriveMintMetadata };

/** Wrapped SOL — the quote mint of every Next pool. */
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** SPL Token program (hardcoded so the server needs no @solana/spl-token dependency). */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token base units per whole token (6 decimals). */
export const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;

export const connection = new Connection(config.solana.rpcUrl, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 90_000,
  ...(config.solana.rpcWsUrl ? { wsEndpoint: config.solana.rpcWsUrl } : {}),
});

export const dbc = DynamicBondingCurveClient.create(connection, "confirmed");

function parsePubkey(raw: string | null, label: string): PublicKey | null {
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    log(`ignoring invalid ${label} "${raw}"`, "solana");
    return null;
  }
}

/** Meteora partner config every Next coin launches through. Null → launching is disabled. */
export const configPubkey = parsePubkey(config.solana.dbcConfig, "DBC_CONFIG");
/** Wallet receiving the platform (partner) share of the swap fees. */
export const treasuryPubkey = parsePubkey(config.solana.treasuryWallet, "TREASURY_WALLET");
/** Creation works end to end only when a config is set. */
export const launchEnabled = configPubkey !== null;

export function clusterInfo(): ClusterInfo {
  return {
    cluster: config.solana.cluster,
    testnet: config.solana.testnet,
    explorer: config.solana.explorer,
    dbcConfig: configPubkey?.toBase58() ?? null,
    treasury: treasuryPubkey?.toBase58() ?? null,
  };
}

/** Solscan link for a transaction signature, a token mint or any other account. */
export function explorerUrl(kind: "tx" | "token" | "account", id: string): string {
  const suffix = config.solana.cluster === "mainnet-beta" ? "" : `?cluster=${config.solana.cluster}`;
  return `${config.solana.explorer}/${kind}/${id}${suffix}`;
}

// ---------------------------------------------------------------------------
// Unit conversions (pure)
// ---------------------------------------------------------------------------

type BnLike = BN | number | string | bigint;

/** Number of a BN/bigint/string without throwing on values above Number.MAX_SAFE_INTEGER. */
export function toNumber(value: BnLike): number {
  if (typeof value === "number") return value;
  return Number(value.toString());
}

export function lamportsToSol(lamports: BnLike): number {
  return toNumber(lamports) / LAMPORTS_PER_SOL;
}

/** SOL → lamports as a BN (rounded to the nearest lamport; negatives clamp to 0). */
export function solToLamports(sol: number): BN {
  if (!Number.isFinite(sol) || sol <= 0) return new BN(0);
  return new BN(Math.round(sol * LAMPORTS_PER_SOL).toString());
}

export function baseUnitsToTokens(units: BnLike): number {
  return toNumber(units) / TOKEN_UNIT;
}

/** Whole tokens → base units as a BN (floored, so a sell never exceeds the balance). */
export function tokensToBaseUnits(tokens: number): BN {
  if (!Number.isFinite(tokens) || tokens <= 0) return new BN(0);
  return new BN(Math.floor(tokens * TOKEN_UNIT).toString());
}

/** Spot price in SOL per whole token from a Q64.64 sqrt price. */
export function priceFromSqrt(sqrtPrice: BnLike): number {
  const bn = sqrtPrice instanceof BN ? sqrtPrice : new BN(sqrtPrice.toString());
  return Number(getPriceFromSqrtPrice(bn, TokenDecimal.SIX, TokenDecimal.NINE).toString());
}

/** Market cap in SOL of a coin trading at `priceSol` (whole supply). */
export function marketCapSol(priceSol: number): number {
  return priceSol * TOTAL_SUPPLY;
}

// ---------------------------------------------------------------------------
// SOL/USD (CoinGecko, refreshed every minute, never throws)
// ---------------------------------------------------------------------------

const SOL_USD_REFRESH_MS = 60_000;
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

let solUsd = config.solana.solUsdFallback;
let solUsdTimer: NodeJS.Timeout | null = null;

/** Last known SOL price in USD. Always a positive number. */
export function getSolUsd(): number {
  return solUsd;
}

/** Fetch the SOL price once. Returns the value in use afterwards; never throws. */
export async function refreshSolUsd(): Promise<number> {
  try {
    const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { solana?: { usd?: unknown } };
    const value = Number(json?.solana?.usd);
    if (Number.isFinite(value) && value > 0) solUsd = value;
  } catch (err) {
    log(`SOL price refresh failed (${(err as Error).message}); keeping ${solUsd}`, "solana");
  }
  return solUsd;
}

/** Start the 60 s price refresher (idempotent). */
export function startSolUsdRefresh(): void {
  if (solUsdTimer) return;
  void refreshSolUsd();
  solUsdTimer = setInterval(() => void refreshSolUsd(), SOL_USD_REFRESH_MS);
  solUsdTimer.unref();
}

export function stopSolUsdRefresh(): void {
  if (!solUsdTimer) return;
  clearInterval(solUsdTimer);
  solUsdTimer = null;
}

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

/** The flattened fields of a virtual pool account (anchor nests them under `poolState`). */
export type PoolState = VirtualPool["poolState"];

export function poolStateOf(pool: VirtualPool): PoolState {
  return pool.poolState;
}

/**
 * Curve state of a pool, derived purely from the two accounts we already hold
 * (`getPoolQuoteTokenCurveProgress` / `getPoolMigrationQuoteThreshold` do exactly
 * this internally, at the cost of four extra RPC round-trips per pool).
 */
export function curveStateFrom(pool: VirtualPool, poolConfig: PoolConfig, slot: number): CurveState {
  const state = poolStateOf(pool);
  const threshold = lamportsToSol(poolConfig.migrationQuoteThreshold);
  const quoteReserveSol = lamportsToSol(state.quoteReserve);
  const progress = threshold > 0 ? Math.min(1, Math.max(0, quoteReserveSol / threshold)) : 0;
  const migrated = Number(state.isMigrated) !== 0;
  return {
    quoteReserveSol,
    baseReserve: baseUnitsToTokens(state.baseReserve),
    priceSol: priceFromSqrt(state.sqrtPrice),
    progress,
    solToGraduate: Math.max(0, threshold - quoteReserveSol),
    completed: progress >= 1 || migrated,
    migrated,
    dammPool: migrated ? dammV2PoolAddress(state.baseMint, poolConfig) : null,
    slot,
  };
}

/** DAMM v2 pool the liquidity migrates into (best effort: derived, not fetched). */
export function dammV2PoolAddress(baseMint: PublicKey, poolConfig: PoolConfig): string | null {
  try {
    const feeConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(poolConfig.migrationFeeOption)];
    if (!feeConfig) return null;
    return deriveDammV2PoolAddress(feeConfig, baseMint, poolConfig.quoteMint).toBase58();
  } catch {
    return null;
  }
}

/** Pool config accounts never change; one fetch per config address is enough. */
const poolConfigCache = new Map<string, PoolConfig>();

export async function getPoolConfig(address: PublicKey): Promise<PoolConfig> {
  const key = address.toBase58();
  const cached = poolConfigCache.get(key);
  if (cached) return cached;
  const fetched = await dbc.state.getPoolConfig(address);
  if (!fetched) throw new Error(`DBC config ${key} not found on ${config.solana.cluster}`);
  poolConfigCache.set(key, fetched);
  return fetched;
}

/** Reads a pool account and turns it into the CurveState the API exposes. */
export async function readPoolState(pool: PublicKey | string): Promise<{ pool: VirtualPool; curve: CurveState } | null> {
  const address = typeof pool === "string" ? new PublicKey(pool) : pool;
  const account = await dbc.state.getPool(address);
  if (!account) return null;
  const poolConfig = await getPoolConfig(poolStateOf(account).config);
  const slot = await connection.getSlot("confirmed").catch(() => 0);
  return { pool: account, curve: curveStateFrom(account, poolConfig, slot) };
}

/** Every pool launched through Next's config. */
export async function listPools(): Promise<{ address: PublicKey; pool: VirtualPool }[]> {
  if (!configPubkey) return [];
  const accounts = await dbc.state.getPoolsByConfig(configPubkey);
  return accounts.map((a) => ({ address: a.publicKey, pool: a.account }));
}

/** Unclaimed trading fees on a pool, in SOL. */
export async function getPoolFees(pool: PublicKey | string): Promise<{ partnerSol: number; creatorSol: number; totalSol: number }> {
  const metrics = await dbc.state.getPoolFeeMetrics(pool);
  return {
    partnerSol: lamportsToSol(metrics.current.partnerQuoteFee),
    creatorSol: lamportsToSol(metrics.current.creatorQuoteFee),
    totalSol: lamportsToSol(metrics.total.totalTradingQuoteFee),
  };
}

/** The pool address a mint launched through Next's config lives at. */
export function poolAddressForMint(mint: PublicKey | string): PublicKey {
  if (!configPubkey) throw new Error("DBC_CONFIG is not configured");
  return deriveDbcPoolAddress(NATIVE_MINT, typeof mint === "string" ? new PublicKey(mint) : mint, configPubkey);
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export type TradeSide = "buy" | "sell";

/**
 * What `dbc.pool.swapQuote` actually returns (the SDK's own `SwapQuoteResult`
 * is derived from the anchor IDL types and does not expand to its fields).
 * Mirrors the program's `SwapResult` struct plus the slippage-adjusted minimum:
 * `totalFee = tradingFee + protocolFee + referralFee`, all in quote lamports
 * because the config collects fees in the quote token.
 */
export interface RawSwapQuote {
  /** input actually consumed, in input-token base units (fee included) */
  actualInputAmount: BN;
  /** output before slippage, in output-token base units */
  outputAmount: BN;
  /** Q64.64 sqrt price after the swap */
  nextSqrtPrice: BN;
  tradingFee: BN;
  protocolFee: BN;
  referralFee: BN;
  /** outputAmount reduced by slippageBps */
  minimumAmountOut: BN;
}

/**
 * Converts a raw SDK swap quote into the API's TradeQuote (pure — unit-tested
 * with a hand-built pool state, no RPC involved).
 *
 * Buys spend SOL for tokens, sells spend tokens for SOL. Fees are always
 * collected in the quote token (the config uses CollectFeeMode.QuoteToken), so
 * the fee is the sum of the three quote-denominated fee buckets.
 */
export function toTradeQuote(params: {
  side: TradeSide;
  amountIn: BN;
  result: RawSwapQuote;
  sqrtPriceBefore: BnLike;
  quoteReserve: BnLike;
  migrationQuoteThreshold: BnLike;
}): TradeQuote {
  const { side, amountIn, result } = params;
  const buy = side === "buy";

  const feeSol = lamportsToSol(result.tradingFee.add(result.protocolFee).add(result.referralFee));
  const priceBeforeSol = priceFromSqrt(params.sqrtPriceBefore);
  const priceAfterSol = priceFromSqrt(result.nextSqrtPrice);

  const quoteReserveAfter = buy
    ? toNumber(params.quoteReserve) + toNumber(result.actualInputAmount)
    : toNumber(params.quoteReserve) - toNumber(result.outputAmount);

  return {
    side,
    amountIn: buy ? lamportsToSol(amountIn) : baseUnitsToTokens(amountIn),
    amountOut: buy ? baseUnitsToTokens(result.outputAmount) : lamportsToSol(result.outputAmount),
    minOut: buy ? baseUnitsToTokens(result.minimumAmountOut) : lamportsToSol(result.minimumAmountOut),
    feeSol,
    priceBeforeSol,
    priceAfterSol,
    priceImpact: priceBeforeSol > 0 ? (priceAfterSol - priceBeforeSol) / priceBeforeSol : 0,
    marketCapAfterSol: marketCapSol(priceAfterSol),
    completesCurve: quoteReserveAfter >= toNumber(params.migrationQuoteThreshold),
  };
}

/**
 * Prices a trade against the live pool. `amount` is SOL for buys and whole
 * tokens for sells. Throws when the curve is already complete (the SDK does).
 */
export async function quote(
  pool: PublicKey | string,
  side: TradeSide,
  amount: number,
  slippageBps: number,
): Promise<TradeQuote> {
  const address = typeof pool === "string" ? new PublicKey(pool) : pool;
  const virtualPool = await dbc.state.getPool(address);
  if (!virtualPool) throw new Error("Pool not found");
  const poolConfig = await getPoolConfig(poolStateOf(virtualPool).config);
  const currentPoint = await getCurrentPoint(connection, ActivationType.Slot);

  const amountIn = side === "buy" ? solToLamports(amount) : tokensToBaseUnits(amount);
  if (amountIn.isZero()) throw new Error("Amount is too small");

  const result = dbc.pool.swapQuote({
    virtualPool,
    config: poolConfig,
    swapBaseForQuote: side === "sell",
    amountIn,
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  }) as unknown as RawSwapQuote;

  return toTradeQuote({
    side,
    amountIn,
    result,
    sqrtPriceBefore: poolStateOf(virtualPool).sqrtPrice,
    quoteReserve: poolStateOf(virtualPool).quoteReserve,
    migrationQuoteThreshold: poolConfig.migrationQuoteThreshold,
  });
}

// ---------------------------------------------------------------------------
// Transaction building (all unsigned; the user's wallet signs)
// ---------------------------------------------------------------------------

export interface BuiltTx {
  /** base64 serialized, unsigned (except for a co-signing mint keypair) */
  tx: string;
  lastValidBlockHeight: number;
}

/** Sets the fee payer + a fresh blockhash and serializes without requiring signatures. */
async function finalize(tx: Transaction, feePayer: PublicKey, extraSigners: Keypair[] = []): Promise<BuiltTx> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  for (const signer of extraSigners) tx.partialSign(signer);
  return {
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight,
  };
}

/** Buy/sell transaction for `owner` against `pool`. Amounts are SOL (buy) / tokens (sell). */
export async function buildSwapTx(params: {
  owner: PublicKey;
  pool: PublicKey;
  side: TradeSide;
  amount: number;
  minOut: number;
}): Promise<BuiltTx> {
  const buy = params.side === "buy";
  const tx = await dbc.pool.swap({
    owner: params.owner,
    pool: params.pool,
    amountIn: buy ? solToLamports(params.amount) : tokensToBaseUnits(params.amount),
    minimumAmountOut: buy ? tokensToBaseUnits(params.minOut) : solToLamports(params.minOut),
    swapBaseForQuote: !buy,
    referralTokenAccount: null,
  });
  return finalize(tx, params.owner);
}

/**
 * Pool creation, optionally with the creator's first buy in the same transaction.
 * The mint keypair must sign, so it is partially signed here; the wallet adds the
 * payer signature.
 */
export async function buildCreateTx(params: {
  payer: PublicKey;
  poolCreator: PublicKey;
  baseMint: Keypair;
  name: string;
  symbol: string;
  uri: string;
  firstBuySol: number;
  minOut: number;
}): Promise<BuiltTx> {
  if (!configPubkey) throw new Error("DBC_CONFIG is not configured");
  const buyAmount = solToLamports(params.firstBuySol);
  const tx = await dbc.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: params.name,
      symbol: params.symbol,
      uri: params.uri,
      payer: params.payer,
      poolCreator: params.poolCreator,
      config: configPubkey,
      baseMint: params.baseMint.publicKey,
    },
    firstBuyParam: buyAmount.isZero()
      ? undefined
      : {
          buyer: params.payer,
          buyAmount,
          minimumAmountOut: tokensToBaseUnits(params.minOut),
          referralTokenAccount: null,
        },
  });
  return finalize(tx, params.payer, [params.baseMint]);
}

/** Lets a coin's creator claim their 10% share of the trading fees. */
export async function buildClaimCreatorFeeTx(creator: PublicKey, pool: PublicKey): Promise<BuiltTx> {
  const tx = await dbc.creator.claimCreatorTradingFee({
    creator,
    payer: creator,
    pool,
    maxBaseAmount: U64_MAX,
    maxQuoteAmount: U64_MAX,
  });
  return finalize(tx, creator);
}

/** Lets the treasury (the config's feeClaimer) claim the platform share. */
export async function buildClaimPartnerFeeTx(feeClaimer: PublicKey, pool: PublicKey): Promise<BuiltTx> {
  const tx = await dbc.partner.claimPartnerTradingFee({
    feeClaimer,
    payer: feeClaimer,
    pool,
    maxBaseAmount: U64_MAX,
    maxQuoteAmount: U64_MAX,
  });
  return finalize(tx, feeClaimer);
}

// ---------------------------------------------------------------------------
// Relaying
// ---------------------------------------------------------------------------

/** Relays a fully signed transaction and waits for confirmation. Returns its signature. */
export async function sendSignedTx(base64: string): Promise<string> {
  const raw = Buffer.from(base64, "base64");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(result.value.err)}`);
  return signature;
}

// ---------------------------------------------------------------------------
// Balances & holders
// ---------------------------------------------------------------------------

export async function getSolBalance(wallet: PublicKey | string): Promise<number> {
  const address = typeof wallet === "string" ? new PublicKey(wallet) : wallet;
  return lamportsToSol(await connection.getBalance(address, "confirmed"));
}

/** Whole-token balances of `wallet` for the given mints (missing accounts read as 0). */
export async function getTokenBalances(wallet: PublicKey | string, mints: string[]): Promise<Map<string, number>> {
  const owner = typeof wallet === "string" ? new PublicKey(wallet) : wallet;
  const balances = new Map<string, number>();
  if (mints.length === 0) return balances;
  const wanted = new Set(mints);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
  for (const { account } of accounts.value) {
    const parsed = (account.data as ParsedAccountData).parsed as {
      info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } };
    };
    const mint = parsed?.info?.mint;
    if (!mint || !wanted.has(mint)) continue;
    const amount = parsed.info?.tokenAmount?.uiAmount ?? 0;
    balances.set(mint, (balances.get(mint) ?? 0) + amount);
  }
  return balances;
}

export interface ChainHolder {
  /** token account address (not the owner — getTokenLargestAccounts does not expose it) */
  address: string;
  tokens: number;
}

const HOLDER_CACHE_MS = 30_000;
const holderCache = new Map<string, { at: number; holders: ChainHolder[]; total: number }>();

/**
 * The 20 largest token accounts of a mint, cached for 30 s. Returns the token
 * *account* addresses; the caller maps the curve's own vault and known wallets.
 */
export async function getTopHolders(mint: string): Promise<{ holders: ChainHolder[]; total: number }> {
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.at < HOLDER_CACHE_MS) return { holders: cached.holders, total: cached.total };

  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), "confirmed");
  const holders = largest.value
    .map((a) => ({ address: a.address.toBase58(), tokens: a.uiAmount ?? 0 }))
    .filter((h) => h.tokens > 0);
  const entry = { at: Date.now(), holders, total: holders.length };
  holderCache.set(mint, entry);
  return { holders: entry.holders, total: entry.total };
}

/** Owner of a token account (holders come back as accounts, the UI wants wallets). */
export async function getTokenAccountOwners(accounts: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (accounts.length === 0) return owners;
  const infos = await connection.getMultipleParsedAccounts(
    accounts.map((a) => new PublicKey(a)),
    { commitment: "confirmed" },
  );
  infos.value.forEach((info, i) => {
    const parsed = info?.data as ParsedAccountData | undefined;
    const owner = (parsed?.parsed as { info?: { owner?: string } } | undefined)?.info?.owner;
    if (owner) owners.set(accounts[i], owner);
  });
  return owners;
}

// ---------------------------------------------------------------------------
// Metaplex metadata (minimal borsh reader)
// ---------------------------------------------------------------------------

export interface OnChainMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Decodes the first three strings of a Metaplex `Metadata` account:
 *
 *   key(1) | updateAuthority(32) | mint(32) | name | symbol | uri
 *
 * Each string is a u32 LE byte length followed by that many bytes, right-padded
 * with NULs by the Metaplex program. Returns null when the buffer is too short
 * or the lengths are implausible (i.e. it is not a metadata account).
 */
export function decodeMetaplexMetadata(data: Uint8Array): OnChainMetadata | null {
  const MAX_STRING = 1024;
  let offset = 1 + 32 + 32;
  if (data.length < offset + 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > data.length) return null;
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > MAX_STRING || offset + length > data.length) return null;
    out.push(decoder.decode(data.subarray(offset, offset + length)).replace(/\0+$/, "").trim());
    offset += length;
  }
  return { name: out[0], symbol: out[1], uri: out[2] };
}

/** Reads a mint's on-chain name/symbol/uri, or null when it has no metadata account. */
export async function readMintMetadata(mint: PublicKey | string): Promise<OnChainMetadata | null> {
  const address = typeof mint === "string" ? new PublicKey(mint) : mint;
  const account = await connection.getAccountInfo(deriveMintMetadata(address), "confirmed");
  if (!account) return null;
  return decodeMetaplexMetadata(account.data);
}
