import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MARKET_CATEGORIES = [
  "Politics",
  "Crypto",
  "Sports",
  "Tech",
  "Culture",
  "Science",
  "Business",
  "World",
] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

/** pending = awaiting admin review, rejected = declined by admin */
export const MARKET_STATUSES = ["pending", "open", "closed", "resolved", "rejected"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

export const OUTCOME_COLORS = [
  "#2E5BFF", // blue
  "#FF8B3D", // orange
  "#8B5CF6", // purple
  "#14B8A6", // teal
  "#EC4899", // pink
  "#EAB308", // yellow
  "#06B6D4", // cyan
  "#84CC16", // lime
] as const;

export const YES_COLOR = "#27AE60";
export const NO_COLOR = "#E64800";

export type AuthProvider = "google" | "apple" | "email";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  email: string;
  username: string;
  avatarSeed: string;
  provider: AuthProvider;
  isAdmin: boolean;
  /** USDC balance available for trading (off-chain ledger, 6 dp) */
  balance: number;
  /** index in the HD wallet used to derive this user's deposit address */
  depositIndex: number;
  depositAddress: string;
  createdAt: string;
}

export type PublicUser = Pick<User, "id" | "username" | "avatarSeed">;
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
// Markets
// ---------------------------------------------------------------------------

export interface MarketOutcome {
  id: number; // index into q[] / prices
  name: string;
  color: string;
}

export interface Market {
  id: number;
  slug: string;
  question: string;
  description: string;
  rules: string;
  category: MarketCategory;
  imageEmoji: string;
  creatorId: number;
  status: MarketStatus;
  /** true when the market is a plain Yes/No question */
  binary: boolean;
  outcomes: MarketOutcome[];
  /** resolved outcome id */
  resolution: number | null;
  rejectionReason: string | null;
  // LMSR state
  liquidity: number;
  q: number[];
  volume: number;
  featured: boolean;
  endDate: string;
  createdAt: string;
  publishedAt: string | null;
  resolvedAt: string | null;
}

export const createMarketSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(10, "The question must be at least 10 characters")
      .max(160, "Keep the question under 160 characters"),
    description: z.string().trim().min(10, "Add a short description").max(3000),
    rules: z.string().trim().min(10, "Resolution rules are required").max(5000),
    category: z.enum(MARKET_CATEGORIES),
    imageEmoji: z.string().trim().min(1).max(8).default("🔮"),
    endDate: z
      .string()
      .refine((d) => !Number.isNaN(Date.parse(d)), "Invalid date")
      .refine((d) => Date.parse(d) > Date.now() + 3600_000, "End date must be at least 1 hour in the future"),
    /** Yes/No market when omitted or 2 entries named Yes/No */
    outcomes: z
      .array(z.string().trim().min(1).max(40))
      .min(2, "At least two outcomes")
      .max(8, "At most eight outcomes")
      .default(["Yes", "No"]),
    /** initial probabilities, must sum to ~1; defaults to uniform */
    initialProbabilities: z.array(z.number().min(0.01).max(0.99)).optional(),
    liquidity: z.number().min(100).max(100000).default(1000),
  })
  .superRefine((v, ctx) => {
    const names = v.outcomes.map((o) => o.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "Outcome names must be unique", path: ["outcomes"] });
    }
    if (v.initialProbabilities) {
      if (v.initialProbabilities.length !== v.outcomes.length) {
        ctx.addIssue({ code: "custom", message: "One probability per outcome", path: ["initialProbabilities"] });
      } else {
        const sum = v.initialProbabilities.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.02) {
          ctx.addIssue({ code: "custom", message: "Probabilities must add up to 100%", path: ["initialProbabilities"] });
        }
      }
    }
  });
export type CreateMarketInput = z.infer<typeof createMarketSchema>;

export const resolveMarketSchema = z.object({ outcomeId: z.number().int().min(0) });
export const reviewMarketSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(500).optional(),
  featured: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Positions & trades
// ---------------------------------------------------------------------------

export interface Position {
  id: number;
  userId: number;
  marketId: number;
  outcomeId: number;
  shares: number;
  /** total USDC paid for the shares currently held */
  costBasis: number;
  realizedPnl: number;
}

export interface Trade {
  id: number;
  userId: number;
  marketId: number;
  outcomeId: number;
  side: "buy" | "sell";
  shares: number;
  amount: number;
  avgPrice: number;
  /** all outcome prices after the trade */
  pricesAfter: number[];
  createdAt: string;
}

export const tradeSchema = z.object({
  outcomeId: z.number().int().min(0),
  side: z.enum(["buy", "sell"]),
  /** buy: USDC to spend; sell: shares to sell */
  amount: z.number().positive().finite(),
});
export type TradeInput = z.infer<typeof tradeSchema>;

export interface PricePoint {
  t: string;
  p: number[];
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  marketId: number;
  userId: number;
  parentId: number | null;
  body: string;
  likes: number[]; // user ids
  createdAt: string;
}

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  parentId: z.number().int().positive().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Wallet
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
  /** magic links are shown in the UI instead of being emailed */
  magicLinkDevMode: boolean;
  /** email sign-in creates the session immediately, without a verification link (pre-launch mode) */
  instantEmailLogin: boolean;
  chain: ChainInfo;
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
}

export interface MarketSummary extends Market {
  prices: number[];
  traders: number;
  /** change of the leading (or Yes) outcome over 24h */
  change24h: number;
  creator: PublicUser;
  commentCount: number;
}

export interface CommentView extends Comment {
  user: PublicUser;
  /** the commenter's largest position in this market, if any */
  position: { outcomeId: number; shares: number } | null;
}

export interface MarketDetail extends MarketSummary {
  priceHistory: PricePoint[];
  recentTrades: (Trade & { user: PublicUser })[];
  comments: CommentView[];
  holders: { user: PublicUser; outcomeId: number; shares: number }[];
  myPositions: Position[];
}

export interface PortfolioPosition extends Position {
  market: MarketSummary;
  currentPrice: number;
  currentValue: number;
  unrealizedPnl: number;
}

export interface Portfolio {
  balance: number;
  positionsValue: number;
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  volume: number;
  positions: PortfolioPosition[];
  trades: (Trade & { market: Pick<Market, "id" | "slug" | "question" | "imageEmoji" | "outcomes"> })[];
  history: { t: string; v: number }[];
}

export interface WalletView {
  balance: number;
  depositAddress: string;
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  chain: ChainInfo;
}

export interface LeaderboardEntry {
  rank: number;
  user: PublicUser;
  pnl: number;
  volume: number;
  markets: number;
}

export interface TradeQuote {
  outcomeId: number;
  side: "buy" | "sell";
  shares: number;
  amount: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  maxPayout: number;
}

export interface ActivityItem {
  trade: Trade;
  user: PublicUser;
  market: Pick<Market, "id" | "slug" | "question" | "imageEmoji" | "outcomes" | "binary">;
}

export interface PlatformStats {
  volume: number;
  traders: number;
  openMarkets: number;
  trades: number;
}
