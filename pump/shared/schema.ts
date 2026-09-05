import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total supply minted for every coin (whole tokens). */
export const TOTAL_SUPPLY = 1_000_000_000;
/** Swap fee applied to every buy and sell (2.7%). */
export const SWAP_FEE = 0.027;
/** Share of the collected fee that goes to the coin creator (the rest is platform revenue). */
export const CREATOR_FEE_SHARE = 0.1;
/** Creator can keep between 0% and this share of the supply at launch. */
export const MAX_CREATOR_ALLOCATION = 0.3;
/**
 * Virtual USDC reserve seeding the constant-product curve (sets the launch price).
 * Launch market cap = VIRTUAL_USDC / (TOTAL_SUPPLY + VIRTUAL_TOKENS) × TOTAL_SUPPLY ≈ 5,040 USDC.
 */
export const VIRTUAL_USDC_RESERVE = 6900;
/**
 * Virtual token reserve seeding the curve. Selling the whole supply through the curve
 * multiplies the price by ((TOTAL_SUPPLY + VIRTUAL_TOKENS) / VIRTUAL_TOKENS)² ≈ 13.8×,
 * so the curve sells out at ≈ 69,400 USDC — just past GRADUATION_MCAP — after ≈ 18.5k USDC of net buys.
 */
export const VIRTUAL_TOKEN_RESERVE = 369_000_000;
/** Market cap (USDC) at which a coin is considered "graduated" (cosmetic milestone, like pump.fun's bonding completion). */
export const GRADUATION_MCAP = 69_000;
/** Market cap (USDC) that makes a coin "King of the Hill" on the home page. */
export const KING_MCAP = 30_000;
/** Candle interval for the live chart (ms). */
export const CANDLE_INTERVAL_MS = 60_000;

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
  /** checksummed EVM address for wallet logins */
  walletAddress: string | null;
  isAdmin: boolean;
  /** USDC balance available for trading (off-chain ledger, 6 dp) */
  balance: number;
  /** lifetime creator fee earnings (USDC) */
  creatorEarnings: number;
  depositIndex: number;
  depositAddress: string;
  createdAt: string;
}

export type PublicUser = Pick<User, "id" | "username" | "avatarSeed" | "avatarUrl">;
export type SafeUser = Omit<User, "depositIndex">;

export const updateProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers and underscores"),
});

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

export interface Coin {
  id: number;
  /** platform contract address: 44-char base58, always ends in "noxia" */
  ca: string;
  name: string;
  ticker: string;
  description: string;
  /** served under /uploads/... (or a data URL for seeds) */
  imageUrl: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  creatorId: number;
  /** fraction of TOTAL_SUPPLY minted to the creator at launch (0..MAX_CREATOR_ALLOCATION) */
  creatorAllocation: number;
  // Constant-product curve state: (realUsdc + vUsdc) * (curveTokens + vTokens) = k
  /** USDC actually paid into the curve (net of fees) */
  realUsdc: number;
  /** tokens remaining in the curve */
  curveTokens: number;
  /** total tokens sold out of the curve (held by traders + creator allocation) */
  circulating: number;
  volume: number;
  buys: number;
  sells: number;
  feesCollected: number;
  creatorFees: number;
  graduated: boolean;
  graduatedAt: string | null;
  createdAt: string;
  lastTradeAt: string | null;
}

export const createCoinSchema = z.object({
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
  website: z.string().trim().url().max(200).optional().or(z.literal("")),
  twitter: z.string().trim().max(200).optional().or(z.literal("")),
  telegram: z.string().trim().max(200).optional().or(z.literal("")),
  creatorAllocation: z.number().min(0).max(MAX_CREATOR_ALLOCATION),
  /** optional first buy by the creator, in USDC */
  initialBuy: z.number().min(0).max(100_000).default(0),
});
export type CreateCoinInput = z.infer<typeof createCoinSchema>;

// ---------------------------------------------------------------------------
// Trades, holdings, candles
// ---------------------------------------------------------------------------

export interface Trade {
  id: number;
  coinId: number;
  userId: number;
  side: "buy" | "sell";
  /** USDC paid (buy, incl. fee) or received (sell, net of fee) */
  usdc: number;
  /** tokens received (buy) or sold (sell) */
  tokens: number;
  fee: number;
  /** price per token after the trade (USDC) */
  price: number;
  /** market cap after the trade (USDC) */
  marketCap: number;
  createdAt: string;
}

export interface Holding {
  id: number;
  userId: number;
  coinId: number;
  tokens: number;
  costBasis: number;
  realizedPnl: number;
}

/** OHLC candle in USDC per token; `t` = bucket start (ms since epoch). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USDC volume */
  v: number;
}

export const tradeSchema = z.object({
  side: z.enum(["buy", "sell"]),
  /** buy: USDC to spend; sell: tokens to sell */
  amount: z.number().positive().finite(),
  /** optional slippage guard: minimum tokens (buy) / minimum USDC (sell) to receive */
  minOut: z.number().min(0).optional(),
});
export type TradeInput = z.infer<typeof tradeSchema>;

export interface TradeQuote {
  side: "buy" | "sell";
  amountIn: number;
  amountOut: number;
  fee: number;
  priceBefore: number;
  priceAfter: number;
  priceImpact: number;
  marketCapAfter: number;
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
// Wallet (same custody model as Foresight)
// ---------------------------------------------------------------------------

export interface Deposit {
  id: number;
  userId: number;
  txHash: string;
  amount: number;
  blockNumber: number;
  createdAt: string;
}

export type WithdrawalStatus = "pending" | "sent" | "failed";

export interface Withdrawal {
  id: number;
  userId: number;
  toAddress: string;
  amount: number;
  status: WithdrawalStatus;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const withdrawSchema = z.object({
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address"),
  amount: z.number().positive().finite(),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const magicLinkRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const idTokenSchema = z.object({ credential: z.string().min(10) });
/** Sign-In-With-Ethereum style: the wallet signs the nonce message issued by /api/auth/wallet/nonce */
export const walletLoginSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  nonce: z.string().min(16).max(128),
});

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

export interface ChainInfo {
  key: string;
  name: string;
  chainId: number;
  testnet: boolean;
  usdcAddress: string;
  explorer: string;
  rpcUrl: string;
  confirmations: number;
}

export interface AppConfig {
  appName: string;
  googleClientId: string | null;
  appleClientId: string | null;
  walletConnectProjectId: string | null;
  instantEmailLogin: boolean;
  magicLinkDevMode: boolean;
  chain: ChainInfo;
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  swapFee: number;
  creatorFeeShare: number;
  totalSupply: number;
  graduationMcap: number;
}

export interface CoinSummary extends Coin {
  price: number;
  marketCap: number;
  /** progress towards GRADUATION_MCAP, 0..1 */
  progress: number;
  holders: number;
  comments: number;
  change24h: number;
  creator: PublicUser;
  /** latest trade, for the live feed */
  lastTrade: (Trade & { user: PublicUser }) | null;
}

export interface CommentView extends Comment {
  user: PublicUser;
  /** commenter's holding in this coin (tokens) */
  holding: number;
}

export interface HolderRow {
  user: PublicUser;
  tokens: number;
  /** share of TOTAL_SUPPLY */
  share: number;
  isCreator: boolean;
}

export interface CoinDetail extends CoinSummary {
  candles: Candle[];
  recentTrades: (Trade & { user: PublicUser })[];
  commentsList: CommentView[];
  topHolders: HolderRow[];
  myHolding: Holding | null;
}

export interface PortfolioHolding extends Holding {
  coin: CoinSummary;
  value: number;
  unrealizedPnl: number;
}

export interface Portfolio {
  balance: number;
  holdingsValue: number;
  totalValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  creatorEarnings: number;
  holdings: PortfolioHolding[];
  trades: (Trade & { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> })[];
  createdCoins: CoinSummary[];
}

export interface WalletView {
  balance: number;
  depositAddress: string;
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  chain: ChainInfo;
}

export interface ActivityItem {
  trade: Trade;
  user: PublicUser;
  coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl">;
}

export interface PlatformStats {
  coins: number;
  volume: number;
  traders: number;
  trades: number;
}

export interface AdminUserRow {
  id: number;
  username: string;
  email: string;
  balance: number;
  isAdmin: boolean;
  createdAt: string;
}

export const adminCreditSchema = z.object({
  username: z.string().trim().min(3).max(25),
  amount: z.number().finite().refine((n) => n !== 0, "Amount must be non-zero"),
});
