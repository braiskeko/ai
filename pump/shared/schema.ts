import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants (mirror the on-chain Meteora Dynamic Bonding Curve config Noxia uses)
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
/** Candle interval for the live chart (ms). */
export const CANDLE_INTERVAL_MS = 60_000;
/** Solana addresses (mints, wallets, pools) are base58, 32–44 chars. */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Vanity suffix Noxia mints end with when a pre-mined address is available. */
export const CA_SUFFIX = "noxia";
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
  avatarSeed: string;
  /** optional custom avatar (data URL / uploaded path) */
  avatarUrl: string | null;
  provider: AuthProvider;
  /** Solana wallet (base58) linked to the account — required to create or trade */
  walletAddress: string | null;
  isAdmin: boolean;
  createdAt: string;
}

export type PublicUser = Pick<User, "id" | "username" | "avatarSeed" | "avatarUrl" | "walletAddress">;
export type SafeUser = User;

export const updateProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers and underscores"),
});

// ---------------------------------------------------------------------------
// Coins (one per on-chain DBC pool created through Noxia's config)
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
  /** token mint address (base58) — the coin's CA; ends in "noxia" when pre-mined */
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
  /** Noxia user linked to that wallet at creation time, if any */
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
  /** Noxia user for that wallet, if known */
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
  /** what the tx is, so the server can index it right away */
  kind: z.enum(["create", "swap", "claim"]),
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

export interface Comment {
  id: number;
  coinId: number;
  userId: number;
  body: string;
  /** optional image attached to the comment (uploads path) */
  imageUrl: string | null;
  likes: number[];
  createdAt: string;
}

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(500),
  image: z.string().regex(/^data:image\/(png|jpe?g|webp|gif);base64,/).max(1_500_000).optional(),
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
  /** Meteora DBC config address Noxia launches through */
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
  /** pre-mined "noxia" mints available right now */
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
}

export interface CoinDetail extends CoinSummary {
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
