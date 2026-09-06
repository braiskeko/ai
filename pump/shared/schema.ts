import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants (mirror the on-chain Meteora Dynamic Bonding Curve config Next uses)
// ---------------------------------------------------------------------------

/** Total supply minted for every coin (whole tokens, 6 decimals on-chain). */
export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
/** Swap fee applied to every buy and sell (2.7%), enforced by the on-chain config. */
export const SWAP_FEE = 0.027;
/** Share of the collected fee that goes to the coin creator (the rest goes to the platform treasury). */
export const CREATOR_FEE_SHARE = 0.1;
/** Target market cap of a freshly launched coin (USD) — the config is built from this. */
export const LAUNCH_MCAP_USD = 5_000;
/** Market cap (USD) at which the bonding curve completes and liquidity migrates to a Meteora DAMM v2 pool. */
export const GRADUATION_MCAP_USD = 69_000;
/**
 * What the creator must buy of their own coin to finish the launch (USD).
 *
 * Filling in the coin costs nothing; this first buy is the transaction that
 * actually creates it on-chain, and the tokens it returns are the creator's own
 * stake in the supply.
 */
export const LAUNCH_MIN_BUY_USD = 1;
/** Smallest order Next accepts, on any market and either side (USD). */
export const MIN_TRADE_USD = 1;
/** Candle interval for the live chart (ms). */
export const CANDLE_INTERVAL_MS = 60_000;
/** Solana addresses (mints, wallets, pools) are base58, 32–44 chars. */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Vanity suffix Next mints end with when a pre-mined address is available. */
export const CA_SUFFIX = "next";
export const LAMPORTS_PER_SOL = 1_000_000_000;

export type AuthProvider = "google" | "apple" | "wallet" | "email";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  /** email for google/apple/email logins; `${address}@wallet.local` for wallet logins */
  email: string;
  username: string;
  /** free-form name shown above the handle; falls back to the username */
  displayName: string | null;
  /** short line under the name on the profile */
  bio: string | null;
  avatarSeed: string;
  /** optional custom avatar (data URL / uploaded path) */
  avatarUrl: string | null;
  /** optional cover image behind the avatar on the profile */
  bannerUrl: string | null;
  provider: AuthProvider;
  /** Solana wallet (base58) linked to the account — required to create or trade */
  walletAddress: string | null;
  isAdmin: boolean;
  createdAt: string;
}

export type PublicUser = Pick<
  User,
  "id" | "username" | "displayName" | "bio" | "avatarSeed" | "avatarUrl" | "bannerUrl" | "walletAddress"
>;
export type SafeUser = User;

/** Longest a profile bio may be. */
export const BIO_MAX = 160;

export const updateProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers and underscores"),
  /** Empty string clears it and falls back to the username. */
  displayName: z.string().trim().max(32).optional(),
  bio: z.string().trim().max(BIO_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Coins (one per on-chain DBC pool created through Next's config)
// ---------------------------------------------------------------------------

/** Live curve state mirrored from the on-chain virtual pool. */
export interface CurveState {
  /** SOL held by the curve (quote reserve), in SOL */
  quoteReserveSol: number;
  /** tokens still in the curve, whole tokens */
  baseReserve: number;
  /** spot price in SOL per token */
  priceSol: number;
  /** 0..1 progress towards the migration threshold */
  progress: number;
  /** SOL still needed (before fees) to complete the curve */
  solToGraduate: number;
  /** curve completed (migration threshold reached) */
  completed: boolean;
  /** liquidity migrated to a DAMM v2 pool */
  migrated: boolean;
  /** address of the DAMM v2 pool after migration */
  dammPool: string | null;
  /** last on-chain slot this state was read at */
  slot: number;
}

export interface Coin {
  id: number;
  /** token mint address (base58) — the coin's CA; ends in "next" when pre-mined */
  ca: string;
  /** DBC virtual pool address */
  pool: string;
  name: string;
  ticker: string;
  description: string;
  /** served under /uploads/... (or an absolute URL) */
  imageUrl: string;
  /** Metaplex metadata JSON served by us (/api/meta/<ca>.json) */
  metadataUri: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  /** wallet that created the pool (pool creator, receives 10% of the fees) */
  creatorWallet: string;
  /** Next user linked to that wallet at creation time, if any */
  creatorId: number | null;
  curve: CurveState;
  /** lifetime SOL volume through the curve (buys + sells, fee included) */
  volumeSol: number;
  buys: number;
  sells: number;
  /** total fees collected in SOL (2.7% of volume) */
  feesSol: number;
  createdAt: string;
  /** creation transaction signature */
  createdTx: string;
  lastTradeAt: string | null;
}

export const coinLinksSchema = {
  website: z.string().trim().url().max(200).optional().or(z.literal("")),
  twitter: z.string().trim().max(200).optional().or(z.literal("")),
  telegram: z.string().trim().max(200).optional().or(z.literal("")),
};

/** Step 1 of creation: upload image + metadata, reserve a (vanity) mint. */
export const prepareCoinSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(32),
  ticker: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(10)
    .regex(/^[A-Z0-9]+$/, "Ticker: letters and numbers only"),
  description: z.string().trim().min(1, "Add a description").max(1000),
  /** data URL (image/png|jpeg|webp|gif), at most ~1.5 MB base64 */
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, "Upload an image").max(2_000_000),
  ...coinLinksSchema,
});
export type PrepareCoinInput = z.infer<typeof prepareCoinSchema>;

export interface PreparedCoin {
  /** reservation id, expires after ~15 minutes */
  id: string;
  /** mint address the pool will use (from the vanity pool when available) */
  mint: string;
  /** true when the mint ends in CA_SUFFIX */
  vanity: boolean;
  metadataUri: string;
  imageUrl: string;
  expiresAt: string;
}

/** Step 2: build the create-pool transaction for the connected wallet to sign. */
/** One asset in a wallet: SOL itself, or an SPL token it holds. */
export interface WalletAsset {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  /** whole tokens (SOL for the native row) */
  amount: number;
  priceUsd: number;
  valueUsd: number;
}

/** A withdrawal: move SOL out of the account's own wallet. */
export const withdrawTxSchema = z.object({
  to: z.string().regex(SOLANA_ADDRESS_RE),
  /** amount in SOL; the fee reserve is enforced server-side */
  amountSol: z.number().positive().finite(),
});
export type WithdrawTxInput = z.infer<typeof withdrawTxSchema>;

export const createTxSchema = z.object({
  prepareId: z.string().min(8).max(64),
  /** creator's wallet (base58); must match the session's wallet */
  wallet: z.string().regex(SOLANA_ADDRESS_RE),
  /** optional first buy by the creator, in SOL */
  initialBuySol: z.number().min(0).max(1000).default(0),
  slippageBps: z.number().int().min(0).max(5000).default(500),
});
export type CreateTxInput = z.infer<typeof createTxSchema>;

// ---------------------------------------------------------------------------
// Trades, holdings, candles
// ---------------------------------------------------------------------------

export interface Trade {
  id: number;
  coinId: number;
  /** transaction signature */
  signature: string;
  /** trader wallet (base58) */
  wallet: string;
  /** Next user for that wallet, if known */
  userId: number | null;
  side: "buy" | "sell";
  /** SOL paid (buy, fee included) or received (sell, net of fee) */
  sol: number;
  /** tokens received (buy) or sold (sell), whole tokens */
  tokens: number;
  /** fee in SOL */
  feeSol: number;
  /** price per token after the trade (SOL) */
  priceSol: number;
  /** market cap after the trade (SOL) */
  marketCapSol: number;
  slot: number;
  createdAt: string;
}

/** Holdings are read from the chain (token accounts) and enriched with indexed cost basis. */
export interface Holding {
  wallet: string;
  coinId: number;
  tokens: number;
  /** SOL spent net of what was received back (indexed from trades; approximate) */
  costBasisSol: number;
  realizedPnlSol: number;
}

/** OHLC candle in SOL per token; `t` = bucket start (ms since epoch). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** SOL volume */
  v: number;
}

export const quoteSchema = z.object({
  side: z.enum(["buy", "sell"]),
  /** buy: SOL to spend; sell: tokens to sell */
  amount: z.number().positive().finite(),
  slippageBps: z.number().int().min(0).max(5000).default(500),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export interface TradeQuote {
  side: "buy" | "sell";
  amountIn: number;
  amountOut: number;
  /** minimum acceptable output after slippage */
  minOut: number;
  feeSol: number;
  priceBeforeSol: number;
  priceAfterSol: number;
  priceImpact: number;
  marketCapAfterSol: number;
  /** curve completes with this trade */
  completesCurve: boolean;
}

/** Build a swap transaction; the wallet signs it and posts it to /api/tx/send. */
export const swapTxSchema = quoteSchema.extend({
  wallet: z.string().regex(SOLANA_ADDRESS_RE),
});
export type SwapTxInput = z.infer<typeof swapTxSchema>;

export interface UnsignedTx {
  /** base64 serialized transaction (unsigned, recent blockhash set) */
  tx: string;
  /** blockhash expiry for the client to show a countdown / retry */
  lastValidBlockHeight: number;
  quote?: TradeQuote;
  /** for creation: the mint the pool will use */
  mint?: string;
}

export const sendTxSchema = z.object({
  /** base64 fully-signed transaction */
  tx: z.string().min(100).max(20_000),
  /**
   * What the tx is, so the server can index it right away. "jupswap" is a
   * Jupiter route through an external token: it is relayed and confirmed like
   * the rest but never indexed as a bonding-curve trade.
   */
  kind: z.enum(["create", "swap", "claim", "jupswap", "withdraw"]),
  ca: z.string().regex(SOLANA_ADDRESS_RE).optional(),
});
export type SendTxInput = z.infer<typeof sendTxSchema>;

export interface SentTx {
  signature: string;
  explorerUrl: string;
  /** confirmed (and indexed) before responding */
  confirmed: boolean;
  /** for creation: the new coin */
  coin?: CoinSummary;
  /** for swaps: the indexed trade */
  trade?: Trade;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A plain comment, or a "thesis": the argument a holder publishes for the position
 * they currently have open. Only holders can post one, and only once every
 * THESIS_COOLDOWN_MS, which is what keeps the holder list readable.
 */
export type CommentKind = "comment" | "thesis";

/** Longest a thesis may be (plain comments stay at 500). */
export const THESIS_MAX_BODY = 1_000;
/** Minimum time between two theses by the same holder on the same coin. */
export const THESIS_COOLDOWN_MS = 10 * 60_000;

export interface Comment {
  id: number;
  coinId: number;
  userId: number;
  body: string;
  /** optional image attached to the comment (uploads path) */
  imageUrl: string | null;
  likes: number[];
  createdAt: string;
  /** absent on comments written before theses existed — read it as "comment" */
  kind?: CommentKind;
}

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(500),
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/).max(1_500_000).optional(),
  kind: z.literal("comment").optional(),
});

export const thesisSchema = z.object({
  body: z.string().trim().min(1).max(THESIS_MAX_BODY),
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/).max(1_500_000).optional(),
  kind: z.literal("thesis"),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const magicLinkRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const idTokenSchema = z.object({ credential: z.string().min(10) });
/** Sign-In-With-Solana style: the wallet signs the nonce message issued by /api/auth/wallet/nonce */
export const walletLoginSchema = z.object({
  address: z.string().regex(SOLANA_ADDRESS_RE),
  /** base58 ed25519 signature of the challenge message */
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/),
  nonce: z.string().min(16).max(128),
});

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

export interface ClusterInfo {
  /** "mainnet-beta" | "devnet" */
  cluster: string;
  testnet: boolean;
  explorer: string;
  /** Meteora DBC config address Next launches through */
  dbcConfig: string | null;
  /** wallet that receives the platform share of the fees */
  treasury: string | null;
}

export interface AppConfig {
  appName: string;
  googleClientId: string | null;
  appleClientId: string | null;
  instantEmailLogin: boolean;
  magicLinkDevMode: boolean;
  chain: ClusterInfo;
  /** SOL/USD used for every dollar figure in the UI */
  solUsd: number;
  swapFee: number;
  creatorFeeShare: number;
  totalSupply: number;
  launchMcapUsd: number;
  graduationMcapUsd: number;
  /** pre-mined "next" mints available right now */
  vanityAvailable: number;
  /** creation works end-to-end (config + RPC reachable) */
  launchEnabled: boolean;
}

export interface CoinSummary extends Coin {
  /** spot price in SOL */
  priceSol: number;
  /** market cap in SOL */
  marketCapSol: number;
  /** progress towards graduation, 0..1 */
  progress: number;
  holders: number;
  comments: number;
  change24h: number;
  creator: PublicUser;
  /** latest trade, for the live feed */
  lastTrade: (Trade & { user: PublicUser | null }) | null;
}

export interface CommentView extends Comment {
  user: PublicUser;
  /** commenter's holding in this coin (tokens) */
  holding: number;
  /** always set on the wire, even for rows stored before theses existed */
  kind: CommentKind;
  /** the commenter's wallet, so theses can be matched to the holder rows */
  wallet: string | null;
}

export interface HolderRow {
  wallet: string;
  user: PublicUser | null;
  tokens: number;
  /** share of TOTAL_SUPPLY */
  share: number;
  isCreator: boolean;
  /** the bonding curve itself */
  isCurve: boolean;
  /**
   * SOL this wallet is net down on the position, from the indexed trades. 0 when
   * the wallet never traded here (it received the tokens some other way), which
   * is why the average entry is only shown when this is positive.
   */
  costBasisSol: number;
}

export interface CoinDetail extends CoinSummary {
  /** After migration the coin trades in a real pool, which has a TradingView chart. */
  chartEmbedUrl?: string | null;
  candles: Candle[];
  recentTrades: (Trade & { user: PublicUser | null })[];
  commentsList: CommentView[];
  topHolders: HolderRow[];
  /** connected wallet's holding (null when not connected / none) */
  myHolding: Holding | null;
  /** creator fees claimable on this pool (SOL) — shown to the creator */
  creatorClaimableSol: number;
}

export interface PortfolioHolding extends Holding {
  coin: CoinSummary;
  valueSol: number;
  unrealizedPnlSol: number;
}

export interface Portfolio {
  wallet: string | null;
  /** wallet SOL balance */
  balanceSol: number;
  holdingsValueSol: number;
  totalValueSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  /** creator fees claimable across the wallet's coins (SOL) */
  creatorClaimableSol: number;
  holdings: PortfolioHolding[];
  trades: (Trade & { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> })[];
  createdCoins: CoinSummary[];
}

export interface WalletView {
  wallet: string | null;
  balanceSol: number;
  solUsd: number;
  chain: ClusterInfo;
}

export interface ActivityItem {
  trade: Trade;
  user: PublicUser | null;
  coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl">;
}

export interface PublicProfile {
  user: PublicUser;
  /** coins this user launched, newest first */
  createdCoins: CoinSummary[];
  /** the user's own trades, newest first */
  trades: (Trade & { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> })[];
  joinedAt: string;
  /** distinct coins the user's wallet still holds */
  holdingsCount: number;
  /** wallets following this profile's wallet (0 when no wallet is linked) */
  followers: number;
  /** wallets this profile's wallet follows */
  following: number;
  /** whether the viewer (if any) follows this profile's wallet */
  isFollowing: boolean;
  /** lifetime SOL volume traded by this wallet */
  volumeSol: number;
  /** number of trades this wallet has made */
  tradeCount: number;
  /** average time between a position's first and last trade, in minutes */
  avgHoldMinutes: number;
  /** realised + unrealised PnL across every coin, in SOL */
  pnlSol: number;
  /** the wallet's cash, in SOL — what the profile shows as Total cash */
  cashSol: number;
}

// ---------------------------------------------------------------------------
// Follows & leaderboard (any trader is followable, keyed by wallet address)
// ---------------------------------------------------------------------------

export interface Follow {
  followerWallet: string;
  targetWallet: string;
  createdAt: string;
}

export const followSchema = z.object({ wallet: z.string().regex(SOLANA_ADDRESS_RE) });

export type LeaderboardRange = "24h" | "7d" | "30d" | "all";
export type FeedScope = "global" | "following";

export interface TraderToken {
  ca: string;
  ticker: string;
  imageUrl: string;
}

export interface TraderRank {
  wallet: string;
  user: PublicUser | null;
  rank: number;
  /** realised + unrealised PnL in SOL over the selected range */
  pnlSol: number;
  /** the wallet's largest current holdings, most valuable first */
  topTokens: TraderToken[];
  /** whether the viewer (if any) follows this wallet */
  isFollowing: boolean;
  /** wallets following this wallet */
  followers: number;
}

export interface MyRank {
  rank: number;
  pnlSol: number;
}

export interface FeedEntry {
  kind: "trade" | "created" | "thesis";
  key: string;
  at: string;
  user: PublicUser | null;
  wallet: string;
  coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl">;
  side?: "buy" | "sell";
  sol?: number;
  tokens?: number;
  marketCapSol?: number;
  /** thesis only: what the holder wrote, and how many people backed it */
  body?: string;
  likes?: number;
}

export interface PlatformStats {
  coins: number;
  /** lifetime SOL volume */
  volumeSol: number;
  traders: number;
  trades: number;
  graduated: number;
}

export interface AdminOverview {
  stats: PlatformStats;
  vanityAvailable: number;
  vanityUsed: number;
  /** partner (treasury) fees claimable per pool, in SOL */
  claimable: { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl">; partnerSol: number; creatorSol: number }[];
  indexer: { lastSlot: number; lastSyncAt: string | null; subscribedPools: number; rpcOk: boolean };
}

// ---------------------------------------------------------------------------
// External tokens (any Solana memecoin, discovered and traded through Jupiter)
//
// These live next to — not inside — the `Coin` model above: they are NOT
// launched through Next's bonding-curve config, have no pool of ours, no
// creator, no graduation. Everything here is denominated in USD (prices, caps,
// liquidity, volume) and in whole tokens, never in lamports or base units.
// ---------------------------------------------------------------------------

/** Wrapped SOL: the quote side of every external swap (buy = SOL→mint, sell = mint→SOL). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Where an external token's data came from. Only Jupiter today. */
export type ExternalSource = "jupiter" | "geckoterminal";

/**
 * Chains Next lists tokens from. Solana is the one it launches and trades on;
 * the rest are read-only for now (prices, charts and deposits), which the token
 * page says plainly rather than pretending.
 */
export type Chain = "solana" | "ethereum" | "base" | "bsc" | "monad" | "hyperliquid" | "robinhood";

export const CHAINS: Chain[] = ["solana", "ethereum", "base", "bsc", "monad", "hyperliquid", "robinhood"];

/** Human labels, kept here so server and client cannot drift. */
export const CHAIN_LABELS: Record<Chain, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  base: "Base",
  bsc: "BNB Chain",
  monad: "Monad",
  hyperliquid: "Hyperliquid",
  robinhood: "Robinhood",
};

/** `solana:<mint>` / `base:0x…` — the id a token is addressed by across the app. */
export function tokenId(chain: Chain, address: string): string {
  return `${chain}:${address}`;
}

/** Parses a token id; a bare address is Solana, which keeps old links working. */
export function parseTokenId(raw: string): { chain: Chain; address: string } | null {
  const value = raw.trim();
  if (!value) return null;
  const split = value.indexOf(":");
  if (split === -1) {
    return SOLANA_ADDRESS_RE.test(value) ? { chain: "solana", address: value } : null;
  }
  const chain = value.slice(0, split) as Chain;
  const address = value.slice(split + 1);
  if (!CHAINS.includes(chain) || !address) return null;
  // Solana mints are base58; everything else is usually an 0x address, but not
  // every chain we list uses that shape — so anything address-like is accepted
  // and the upstream decides whether it exists.
  if (chain === "solana" ? !SOLANA_ADDRESS_RE.test(address) : !TOKEN_ADDRESS_RE.test(address)) return null;
  return { chain, address };
}

/** EVM contract addresses. */
export const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
/** Any address-shaped token identifier on a non-Solana chain. */
export const TOKEN_ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;

/** A token discovered through the aggregator, as shown in the "Solana" feed. */
export interface ExternalToken {
  /** `chain:address` — how the token is addressed in URLs and query keys */
  id: string;
  chain: Chain;
  /** contract address: a base58 mint on Solana, an 0x address elsewhere */
  mint: string;
  name: string;
  symbol: string;
  /** logo URL, or null when the token has none */
  icon: string | null;
  decimals: number;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  /** 24 h price change as a fraction (0.12 = +12%) */
  change24h: number;
  volume24hUsd: number;
  holders: number;
  /** listed on a strict/verified token list */
  verified: boolean;
  /** ISO timestamp of the first pool, when known */
  createdAt: string | null;
  source: ExternalSource;
  /** whether Next can execute a swap for it today (Solana only, for now) */
  tradable: boolean;
}

/** Mint-level safety flags reported by the aggregator (null = unknown). */
export interface ExternalTokenAudit {
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  /** share of the supply held by the top holders, as a fraction */
  topHoldersPercent: number | null;
}

/** Where a token's candles came from — shown when there are none, so the reason is visible. */
export type ChartSource = "market" | "samples" | "none";

/** A Next account that holds this token, with what the position is worth. */
export interface ExternalHolder {
  user: PublicUser;
  wallet: string;
  tokens: number;
  valueUsd: number;
}

export interface ExternalTokenDetail extends ExternalToken {
  chartSource: ChartSource;
  /** Holders who have an account here, biggest position first. */
  appHolders: ExternalHolder[];
  /** TradingView-rendered chart for the pool (GeckoTerminal embed), when there is one. */
  chartEmbedUrl: string | null;
  /**
   * OHLC in USD per token (not SOL), derived from the price samples the server
   * records while the token is being viewed — the free aggregator tier has no
   * OHLC endpoint. `v` is always 0 (no per-candle volume available).
   */
  candles: Candle[];
  /** circulating supply implied by marketCapUsd / priceUsd (0 when unknown) */
  supply: number;
  /** aggregator's organic-activity score (0-100), 0 when unknown */
  organicScore: number;
  buys24h: number;
  sells24h: number;
  audit: ExternalTokenAudit;
  links: { website: string | null; twitter: string | null; telegram: string | null };
  /** first (usually deepest) pool this token trades in */
  pool: { id: string | null; dex: string | null; createdAt: string | null } | null;
  /** whole tokens held by the session's wallet (0 when disconnected or unreadable) */
  myTokens: number;
  /** solscan.io link for the mint */
  explorerUrl: string;
  /** jup.ag swap link for the mint */
  jupiterUrl: string;
}

/** `side` is relative to the token: buy spends SOL, sell spends tokens. */
export const externalQuoteSchema = quoteSchema.extend({
  mint: z.string().regex(SOLANA_ADDRESS_RE),
});
export type ExternalQuoteInput = z.infer<typeof externalQuoteSchema>;

export const externalSwapTxSchema = externalQuoteSchema.extend({
  wallet: z.string().regex(SOLANA_ADDRESS_RE),
});
export type ExternalSwapTxInput = z.infer<typeof externalSwapTxSchema>;

/** Whether the aggregator answered recently (drives the "unavailable" UI state). */
/**
 * A perpetual market on Hyperliquid. Prices and volume are USD; `fundingRate` is
 * the 8-hour rate as a fraction.
 */
export interface PerpMarket {
  symbol: string;
  priceUsd: number;
  change24h: number;
  volume24hUsd: number;
  openInterestUsd: number;
  fundingRate: number;
  maxLeverage: number;
  category: PerpCategory;
}

export type PerpCategory = "crypto" | "stocks" | "commodities" | "indices";

/** A perp market plus its candles (USD per unit), for the detail page. */
export interface PerpDetail extends PerpMarket {
  candles: Candle[];
}

export interface ExternalStatus {
  available: boolean;
  lastOkAt: string | null;
  lastError: string | null;
}

/** Vanity keypairs pushed by the grinder (admin token protected). */
export const vanityUploadSchema = z.object({
  keypairs: z
    .array(
      z.object({
        publicKey: z.string().regex(SOLANA_ADDRESS_RE),
        /** base58 64-byte secret key */
        secretKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,96}$/),
      }),
    )
    .min(1)
    .max(500),
});
