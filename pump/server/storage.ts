/**
 * Noxia storage layer.
 *
 * The whole application state lives in memory as one plain, JSON-serialisable
 * object (`State`). Every mutation schedules a debounced snapshot through the
 * `Persister` (file or Postgres, see persistence.ts), so the process can be
 * restarted or redeployed without losing data while every read stays a cheap,
 * synchronous in-memory operation.
 *
 * Conventions used throughout:
 *  - timestamps are ISO-8601 strings
 *  - money is USDC with 6 decimals (`round6`)
 *  - prices are USDC per token on a constant-product bonding curve (curve.ts)
 *  - entity objects are mutated in place; the arrays in `state` own them and
 *    the Maps below are pure lookup indexes over the very same objects
 *  - candles are never stored: they are derived from trades and cached per coin
 */
import { randomUUID } from "crypto";
import { getAddress } from "ethers";
import {
  CANDLE_INTERVAL_MS,
  GRADUATION_MCAP,
  SWAP_FEE,
  TOTAL_SUPPLY,
  VIRTUAL_TOKEN_RESERVE,
  VIRTUAL_USDC_RESERVE,
  type ActivityItem,
  type AdminUserRow,
  type AuthProvider,
  type Candle,
  type Coin,
  type CoinDetail,
  type CoinSummary,
  type Comment,
  type CommentView,
  type CreateCoinInput,
  type Deposit,
  type Holding,
  type HolderRow,
  type PlatformStats,
  type Portfolio,
  type PortfolioHolding,
  type PublicUser,
  type SafeUser,
  type Trade,
  type TradeQuote,
  type User,
  type WalletView,
  type Withdrawal,
  type WithdrawalStatus,
} from "@shared/schema";
import * as curve from "./curve";
import { generateCa } from "./ca";
import { config } from "./config";
import { createBackend, Persister } from "./persistence";
import { coinImageDataUrl, lcg, seedBots, seedCoins, SEED_PRNG_SEED, type SeedCoin } from "./seed";
import { log } from "./vite";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export type CoinSort = "new" | "trending" | "mcap" | "volume" | "graduated";

export interface CoinListFilters {
  sort?: CoinSort;
  search?: string;
  limit?: number;
  creatorId?: number;
}

export type TradeSide = "buy" | "sell";

export interface StorageOptions {
  /** Derives the on-chain deposit address for a user's HD wallet index. */
  deriveDepositAddress: (index: number) => string;
}

/** Next id to hand out for each entity type. */
interface IdCounters {
  user: number;
  coin: number;
  trade: number;
  holding: number;
  comment: number;
  deposit: number;
  withdrawal: number;
}
type IdKind = keyof IdCounters;

/** The complete persisted application state. */
export interface State {
  version: 1;
  /** BIP-39 phrase for deposit-address derivation, generated on first use. */
  mnemonic: string | null;
  /** Last block the on-chain deposit watcher has processed. */
  lastScannedBlock: number | null;
  ids: IdCounters;
  users: User[];
  coins: Coin[];
  trades: Trade[];
  holdings: Holding[];
  comments: Comment[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  /** platform share of all swap fees ever collected (USDC) */
  platformRevenue: number;
  /** admin credits waiting for a user with that (lowercase) username to appear */
  pendingCredits: Record<string, number>;
  /** INITIAL_CREDITS entries ("user:amount") that were already applied */
  appliedCredits: string[];
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Smallest buy accepted (USDC). */
export const MIN_BUY_USDC = 0.01;
const MIN_WITHDRAWAL_USDC = 1;
const FAUCET_COOLDOWN_MS = 10 * MINUTE_MS;
/** Holdings with fewer tokens than this are treated as empty. */
const TOKEN_EPSILON = 1e-6;
/** Tolerance for floating point comparisons of balances / token counts. */
const DUST = 1e-9;
/** How many trades the coin page receives. */
const RECENT_TRADES = 200;
/** How many holders the coin page receives. */
const TOP_HOLDERS = 20;
const DEFAULT_LIST_LIMIT = 60;
/** Bots start with this much play money; their balance is topped up during the seed simulation. */
const BOT_BALANCE = 25_000;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const nowIso = (): string => new Date().toISOString();
const iso = (ms: number): string => new Date(ms).toISOString();
const ts = (isoString: string): number => Date.parse(isoString);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** Start of the 1-minute candle bucket containing `ms`. */
const bucketStart = (ms: number): number => Math.floor(ms / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

/** Newest first, ties broken by id so ordering is stable. */
function newestFirst<T extends { id: number; createdAt: string }>(a: T, b: T): number {
  return ts(b.createdAt) - ts(a.createdAt) || b.id - a.id;
}

/** Oldest first, ties broken by id. */
function oldestFirst<T extends { id: number; createdAt: string }>(a: T, b: T): number {
  return ts(a.createdAt) - ts(b.createdAt) || a.id - b.id;
}

function holdingKey(userId: number, coinId: number): string {
  return `${userId}:${coinId}`;
}

/** Empty string / whitespace links become null. */
function optionalLink(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Curve state of a coin (the two fields curve.ts cares about). */
function curveOf(coin: Coin): curve.CurveState {
  return { realUsdc: coin.realUsdc, curveTokens: coin.curveTokens };
}

/** Spot price the coin launched at, before any trade. */
function launchPrice(coin: Coin): number {
  return curve.spotPrice(curve.initialCurve(coin.creatorAllocation));
}

/** Constant-product invariant k = (U + vU)(T + vT) of a coin's curve at launch. */
function launchInvariant(creatorAllocation: number): number {
  const s = curve.initialCurve(creatorAllocation);
  return (s.realUsdc + VIRTUAL_USDC_RESERVE) * (s.curveTokens + VIRTUAL_TOKEN_RESERVE);
}

/**
 * Market cap at which the curve has sold its last token — the highest price buys can
 * ever push a coin to. Whether that is at or above GRADUATION_MCAP depends on the
 * VIRTUAL_* constants (see the integrator notes / storage tests).
 */
export function selloutMarketCap(creatorAllocation: number): number {
  const k = launchInvariant(creatorAllocation);
  return curve.marketCap({ realUsdc: k / VIRTUAL_TOKEN_RESERVE - VIRTUAL_USDC_RESERVE, curveTokens: 0 });
}

function coinRef(c: Coin): Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> {
  return { id: c.id, ca: c.ca, name: c.name, ticker: c.ticker, imageUrl: c.imageUrl };
}

function emptyState(): State {
  return {
    version: 1,
    mnemonic: null,
    lastScannedBlock: null,
    ids: { user: 1, coin: 1, trade: 1, holding: 1, comment: 1, deposit: 1, withdrawal: 1 },
    users: [],
    coins: [],
    trades: [],
    holdings: [],
    comments: [],
    deposits: [],
    withdrawals: [],
    platformRevenue: 0,
    pendingCredits: {},
    appliedCredits: [],
  };
}

// ---------------------------------------------------------------------------
// Snapshot restore (defensive migration)
// ---------------------------------------------------------------------------

/** Shape of a snapshot as it may come back from disk: anything can be missing. */
interface LooseState {
  version?: number;
  mnemonic?: string | null;
  lastScannedBlock?: number | null;
  ids?: Partial<IdCounters>;
  users?: Partial<User>[];
  coins?: Partial<Coin>[];
  trades?: Partial<Trade>[];
  holdings?: Partial<Holding>[];
  comments?: Partial<Comment>[];
  deposits?: Partial<Deposit>[];
  withdrawals?: Partial<Withdrawal>[];
  platformRevenue?: number;
  pendingCredits?: Record<string, number>;
  appliedCredits?: string[];
}

/** Fills fields missing from a loaded record with sensible defaults. */
function withDefaults<T extends object>(defaults: T, loaded: Partial<T>): T {
  return { ...defaults, ...loaded };
}

/** Id counter that is safely above both the stored counter and every existing id. */
function nextIdAfter(items: { id: number }[], stored: number | undefined): number {
  const maxId = items.reduce((mx, it) => Math.max(mx, it.id), 0);
  return Math.max(stored ?? 1, maxId + 1);
}

function restoreState(json: string): State {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Snapshot is not a JSON object");
  }
  const loose = parsed as LooseState;
  const now = nowIso();

  const users = (loose.users ?? []).map((u) =>
    withDefaults<User>(
      {
        id: 0,
        email: "",
        username: "",
        avatarSeed: "",
        avatarUrl: null,
        provider: "email",
        walletAddress: null,
        isAdmin: false,
        balance: 0,
        creatorEarnings: 0,
        depositIndex: -1,
        depositAddress: "",
        createdAt: now,
      },
      u,
    ),
  );

  const coins = (loose.coins ?? []).map((c) => {
    const creatorAllocation = c.creatorAllocation ?? 0;
    const initial = curve.initialCurve(creatorAllocation);
    return withDefaults<Coin>(
      {
        id: 0,
        ca: "",
        name: "",
        ticker: "",
        description: "",
        imageUrl: "",
        website: null,
        twitter: null,
        telegram: null,
        creatorId: 0,
        creatorAllocation,
        realUsdc: 0,
        curveTokens: initial.curveTokens,
        circulating: TOTAL_SUPPLY * creatorAllocation,
        volume: 0,
        buys: 0,
        sells: 0,
        feesCollected: 0,
        creatorFees: 0,
        graduated: false,
        graduatedAt: null,
        createdAt: now,
        lastTradeAt: null,
      },
      c,
    );
  });

  const trades = (loose.trades ?? []).map((t) =>
    withDefaults<Trade>(
      { id: 0, coinId: 0, userId: 0, side: "buy", usdc: 0, tokens: 0, fee: 0, price: 0, marketCap: 0, createdAt: now },
      t,
    ),
  );

  const holdings = (loose.holdings ?? []).map((h) =>
    withDefaults<Holding>({ id: 0, userId: 0, coinId: 0, tokens: 0, costBasis: 0, realizedPnl: 0 }, h),
  );

  const comments = (loose.comments ?? []).map((c) =>
    withDefaults<Comment>({ id: 0, coinId: 0, userId: 0, body: "", imageUrl: null, likes: [], createdAt: now }, c),
  );

  const deposits = (loose.deposits ?? []).map((d) =>
    withDefaults<Deposit>({ id: 0, userId: 0, txHash: "", amount: 0, blockNumber: 0, createdAt: now }, d),
  );

  const withdrawals = (loose.withdrawals ?? []).map((w) => {
    const createdAt = w.createdAt ?? now;
    return withDefaults<Withdrawal>(
      { id: 0, userId: 0, toAddress: "", amount: 0, status: "pending", txHash: null, error: null, createdAt, updatedAt: createdAt },
      w,
    );
  });

  return {
    version: 1,
    mnemonic: loose.mnemonic ?? null,
    lastScannedBlock: loose.lastScannedBlock ?? null,
    platformRevenue: typeof loose.platformRevenue === "number" ? loose.platformRevenue : 0,
    pendingCredits: loose.pendingCredits ?? {},
    appliedCredits: loose.appliedCredits ?? [],
    ids: {
      user: nextIdAfter(users, loose.ids?.user),
      coin: nextIdAfter(coins, loose.ids?.coin),
      trade: nextIdAfter(trades, loose.ids?.trade),
      holding: nextIdAfter(holdings, loose.ids?.holding),
      comment: nextIdAfter(comments, loose.ids?.comment),
      deposit: nextIdAfter(deposits, loose.ids?.deposit),
      withdrawal: nextIdAfter(withdrawals, loose.ids?.withdrawal),
    },
    users,
    coins,
    trades,
    holdings,
    comments,
    deposits,
    withdrawals,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class Storage {
  private state: State = emptyState();
  private persister: Persister | null = null;

  // Lookup indexes over the objects held in `state` (rebuilt on restore).
  private usersById = new Map<number, User>();
  private usersByEmail = new Map<string, User>();
  /** lowercase wallet address -> user */
  private usersByWallet = new Map<string, User>();
  private coinsById = new Map<number, Coin>();
  private coinsByCa = new Map<string, Coin>();
  private holdingsByKey = new Map<string, Holding>();
  /** coin id -> holdings in that coin (any size, including emptied ones) */
  private holdingsByCoin = new Map<number, Holding[]>();
  /** coin id -> trades in chronological order */
  private tradesByCoin = new Map<number, Trade[]>();
  /** coin id -> comments in insertion order */
  private commentsByCoin = new Map<number, Comment[]>();
  private commentsById = new Map<number, Comment>();
  private withdrawalsById = new Map<number, Withdrawal>();
  private depositTxHashes = new Set<string>();

  /** coin id -> derived 1-minute candles; dropped whenever the coin trades. */
  private candleCache = new Map<number, Candle[]>();

  /** userId -> epoch ms of the last faucet claim (intentionally not persisted). */
  private faucetClaims = new Map<number, number>();

  constructor(private readonly opts: StorageOptions) {}

  // -------------------------------------------------------------------------
  // Lifecycle (used by initStorage)
  // -------------------------------------------------------------------------

  /** Replaces the in-memory state with a persisted snapshot, filling in any missing fields. */
  restore(json: string): void {
    this.state = restoreState(json);
    this.rebuildIndexes();
  }

  /** Attaches the debounced writer and schedules a first save so migrations / seed data hit disk. */
  bindPersister(persister: Persister): void {
    this.persister = persister;
    persister.schedule();
  }

  /** Returns the live state object. Callers must treat it as read-only. */
  snapshot(): State {
    return this.state;
  }

  /** Forces any pending snapshot to be written (used on shutdown). */
  async flush(): Promise<void> {
    await this.persister?.flush();
  }

  private persist(): void {
    this.persister?.schedule();
  }

  private nextId(kind: IdKind): number {
    return this.state.ids[kind]++;
  }

  private rebuildIndexes(): void {
    this.usersById.clear();
    this.usersByEmail.clear();
    this.usersByWallet.clear();
    this.coinsById.clear();
    this.coinsByCa.clear();
    this.holdingsByKey.clear();
    this.holdingsByCoin.clear();
    this.tradesByCoin.clear();
    this.commentsByCoin.clear();
    this.commentsById.clear();
    this.withdrawalsById.clear();
    this.depositTxHashes.clear();
    this.candleCache.clear();
    for (const u of this.state.users) this.indexUser(u);
    for (const c of this.state.coins) this.indexCoin(c);
    for (const h of this.state.holdings) this.indexHolding(h);
    for (const t of this.state.trades.slice().sort(oldestFirst)) this.indexTrade(t);
    for (const c of this.state.comments) this.indexComment(c);
    for (const w of this.state.withdrawals) this.withdrawalsById.set(w.id, w);
    for (const d of this.state.deposits) this.depositTxHashes.add(d.txHash.toLowerCase());
  }

  private indexUser(u: User): void {
    this.usersById.set(u.id, u);
    this.usersByEmail.set(u.email.toLowerCase(), u);
    if (u.walletAddress) this.usersByWallet.set(u.walletAddress.toLowerCase(), u);
  }

  private indexCoin(c: Coin): void {
    this.coinsById.set(c.id, c);
    this.coinsByCa.set(c.ca, c);
  }

  private indexHolding(h: Holding): void {
    this.holdingsByKey.set(holdingKey(h.userId, h.coinId), h);
    let list = this.holdingsByCoin.get(h.coinId);
    if (!list) {
      list = [];
      this.holdingsByCoin.set(h.coinId, list);
    }
    list.push(h);
  }

  private indexTrade(t: Trade): void {
    let list = this.tradesByCoin.get(t.coinId);
    if (!list) {
      list = [];
      this.tradesByCoin.set(t.coinId, list);
    }
    list.push(t);
  }

  private indexComment(c: Comment): void {
    this.commentsById.set(c.id, c);
    let list = this.commentsByCoin.get(c.coinId);
    if (!list) {
      list = [];
      this.commentsByCoin.set(c.coinId, list);
    }
    list.push(c);
  }

  private addUser(u: User): User {
    this.state.users.push(u);
    this.indexUser(u);
    return u;
  }

  private addCoin(c: Coin): Coin {
    this.state.coins.push(c);
    this.indexCoin(c);
    return c;
  }

  private coinTrades(coinId: number): Trade[] {
    return this.tradesByCoin.get(coinId) ?? [];
  }

  private coinHoldings(coinId: number): Holding[] {
    return this.holdingsByCoin.get(coinId) ?? [];
  }

  private coinComments(coinId: number): Comment[] {
    return this.commentsByCoin.get(coinId) ?? [];
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  getUser(id: number): User | undefined {
    return this.usersById.get(id);
  }

  getUserByEmail(email: string): User | undefined {
    return this.usersByEmail.get(email.trim().toLowerCase());
  }

  /** Lookup by EVM address (any casing). Returns undefined for malformed addresses. */
  getUserByWallet(address: string): User | undefined {
    if (typeof address !== "string") return undefined;
    return this.usersByWallet.get(address.trim().toLowerCase());
  }

  /** Case-insensitive username lookup. */
  getUserByUsername(username: string): User | undefined {
    const lower = username.trim().replace(/^@/, "").toLowerCase();
    return this.state.users.find((u) => u.username.toLowerCase() === lower);
  }

  private mustUser(id: number): User {
    const u = this.usersById.get(id);
    if (!u) throw new HttpError(404, "User not found");
    return u;
  }

  /**
   * Looks a user up by email or creates one. Admin status is granted to emails
   * listed in ADMIN_EMAILS and, when that list is empty, to the very first real
   * account on the deployment so a fresh install always has an administrator.
   * Existing users are re-synced against ADMIN_EMAILS but never demoted.
   */
  findOrCreateUser(email: string, provider: AuthProvider, displayName?: string): { user: User; created: boolean } {
    const normalized = email.trim().toLowerCase();
    const listedAdmin = config.adminEmails.includes(normalized);

    const existing = this.getUserByEmail(normalized);
    if (existing) {
      if (listedAdmin && !existing.isAdmin) {
        existing.isAdmin = true;
        this.persist();
      }
      return { user: existing, created: false };
    }

    const user = this.createUser({
      email: normalized,
      provider,
      preferredUsername: displayName?.trim() || normalized.split("@")[0],
      walletAddress: null,
    });
    return { user, created: true };
  }

  /**
   * Sign-in with an EVM wallet. The account is keyed by the checksummed address;
   * its email is the synthetic `${address}@wallet.local` and the handle is derived
   * from the address ("0xAb12…9f3c" -> "ab12_9f3c", made unique).
   */
  findOrCreateWalletUser(address: string): { user: User; created: boolean } {
    let checksummed: string;
    try {
      checksummed = getAddress(address);
    } catch {
      throw new HttpError(400, "Invalid wallet address");
    }
    const lower = checksummed.toLowerCase();
    const email = `${lower}@wallet.local`;

    const existing = this.usersByWallet.get(lower) ?? this.getUserByEmail(email);
    if (existing) {
      if (existing.walletAddress !== checksummed) {
        existing.walletAddress = checksummed;
        this.usersByWallet.set(lower, existing);
        this.persist();
      }
      return { user: existing, created: false };
    }

    const user = this.createUser({
      email,
      provider: "wallet",
      preferredUsername: `${lower.slice(2, 6)}_${lower.slice(-4)}`,
      walletAddress: checksummed,
    });
    return { user, created: true };
  }

  /** Shared account creation: HD wallet index, admin bootstrap, queued credits. */
  private createUser(input: {
    email: string;
    provider: AuthProvider;
    preferredUsername: string;
    walletAddress: string | null;
  }): User {
    const listedAdmin = config.adminEmails.includes(input.email);
    // Bots use depositIndex -1; real users get consecutive HD wallet indexes.
    const realUsers = this.state.users.filter((u) => u.depositIndex >= 0);
    const depositIndex = realUsers.reduce((mx, u) => Math.max(mx, u.depositIndex), -1) + 1;
    const depositAddress = this.opts.deriveDepositAddress(depositIndex);
    const bootstrapAdmin = config.adminEmails.length === 0 && realUsers.length === 0;

    const user = this.addUser({
      id: this.nextId("user"),
      email: input.email,
      username: this.uniqueUsername(input.preferredUsername),
      avatarSeed: randomUUID(),
      avatarUrl: null,
      provider: input.provider,
      walletAddress: input.walletAddress,
      isAdmin: listedAdmin || bootstrapAdmin,
      balance: 0,
      creatorEarnings: 0,
      depositIndex,
      depositAddress,
      createdAt: nowIso(),
    });
    if (bootstrapAdmin) log(`${input.email} is the first account on this deployment and was granted admin`, "storage");
    this.applyPendingCredit(user);
    this.persist();
    return user;
  }

  /** Admin listing for the users tab (bots excluded); newest first, optional substring filter. */
  listUsers(search = "", limit = 50): AdminUserRow[] {
    const needle = search.trim().replace(/^@/, "").toLowerCase();
    return this.state.users
      .filter((u) => u.depositIndex >= 0)
      .filter(
        (u) =>
          !needle ||
          u.username.toLowerCase().includes(needle) ||
          u.email.includes(needle) ||
          (u.walletAddress?.toLowerCase().includes(needle) ?? false),
      )
      .sort(newestFirst)
      .slice(0, limit)
      .map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        balance: u.balance,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
      }));
  }

  /**
   * Adds (or, with a negative amount, removes) USDC from a user's balance. When no
   * user has that username yet the credit is queued and applied the moment an
   * account with that username appears (sign-up or rename).
   */
  adminCreditBalance(username: string, amount: number): { user: User | null; queued: boolean } {
    const handle = username.trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(handle)) throw new HttpError(400, "Invalid username");
    if (!Number.isFinite(amount) || amount === 0) throw new HttpError(400, "Amount must be a non-zero number");
    const user = this.getUserByUsername(handle);
    if (user) {
      const next = round6(user.balance + amount);
      if (next < 0) throw new HttpError(400, `Balance cannot go below zero (current ${user.balance})`);
      user.balance = next;
      log(`admin credit: ${amount} USDC -> @${user.username} (balance ${user.balance})`, "storage");
      this.persist();
      return { user, queued: false };
    }
    if (amount < 0) throw new HttpError(404, `No user named @${handle}`);
    const key = handle.toLowerCase();
    this.state.pendingCredits[key] = round6((this.state.pendingCredits[key] ?? 0) + amount);
    log(`admin credit queued: ${amount} USDC for @${handle} (not registered yet)`, "storage");
    this.persist();
    return { user: null, queued: true };
  }

  /** Applies a queued credit to a user whose username now matches one. */
  private applyPendingCredit(user: User): void {
    const key = user.username.toLowerCase();
    const amount = this.state.pendingCredits[key];
    if (!amount) return;
    delete this.state.pendingCredits[key];
    user.balance = round6(user.balance + amount);
    log(`applied queued credit of ${amount} USDC to @${user.username}`, "storage");
  }

  /**
   * INITIAL_CREDITS="alice:1000,bob:250" — one-off credits given at boot. Each entry is
   * applied exactly once per deployment (tracked in state.appliedCredits) so restarts
   * never double-credit.
   */
  applyInitialCredits(spec: string): void {
    for (const raw of spec.split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      if (this.state.appliedCredits.includes(entry)) continue;
      const [name, amt] = entry.split(":");
      const amount = Number(amt);
      if (!name || !Number.isFinite(amount) || amount <= 0) {
        log(`ignoring malformed INITIAL_CREDITS entry "${entry}"`, "storage");
        continue;
      }
      try {
        this.adminCreditBalance(name, amount);
        this.state.appliedCredits.push(entry);
        this.persist();
      } catch (e) {
        log(`INITIAL_CREDITS "${entry}" failed: ${(e as Error).message}`, "storage");
      }
    }
  }

  /** Sanitises a preferred handle to [a-zA-Z0-9_], 3-24 chars, and makes it unique with a numeric suffix. */
  private uniqueUsername(preferred: string): string {
    let base = preferred.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (base.length < 3) base = "degen";
    base = base.slice(0, 24);
    if (!this.usernameTaken(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, 24 - suffix.length) + suffix;
      if (!this.usernameTaken(candidate)) return candidate;
    }
  }

  private usernameTaken(username: string, exceptUserId?: number): boolean {
    const lower = username.toLowerCase();
    return this.state.users.some((u) => u.id !== exceptUserId && u.username.toLowerCase() === lower);
  }

  updateUsername(userId: number, username: string): User {
    const user = this.mustUser(userId);
    if (this.usernameTaken(username, userId)) throw new HttpError(409, "That username is already taken");
    user.username = username;
    this.applyPendingCredit(user);
    this.persist();
    return user;
  }

  /** Sets (or with null clears) a user's custom avatar. */
  setAvatar(userId: number, imageUrl: string | null): User {
    const user = this.mustUser(userId);
    user.avatarUrl = imageUrl;
    this.persist();
    return user;
  }

  /** Strips fields that must never leave the server. */
  toSafeUser(u: User): SafeUser {
    const { depositIndex: _depositIndex, ...safe } = u;
    return safe;
  }

  toPublicUser(id: number): PublicUser {
    const u = this.usersById.get(id);
    return u
      ? { id: u.id, username: u.username, avatarSeed: u.avatarSeed, avatarUrl: u.avatarUrl }
      : { id, username: "unknown", avatarSeed: "unknown", avatarUrl: null };
  }

  // -------------------------------------------------------------------------
  // Coins: helpers
  // -------------------------------------------------------------------------

  private mustCoin(id: number): Coin {
    const c = this.coinsById.get(id);
    if (!c) throw new HttpError(404, "Coin not found");
    return c;
  }

  /** Raw coin record by contract address (no aggregates); handy for resolving ids in routes. */
  findCoinByCa(ca: string): Coin | undefined {
    return this.coinsByCa.get(ca.trim());
  }

  private uniqueCa(): string {
    for (;;) {
      const ca = generateCa();
      if (!this.coinsByCa.has(ca)) return ca;
    }
  }

  /** Volume traded in the last 24 hours. Trades are chronological, so scan from the end. */
  private volume24h(coinId: number, now: number): number {
    const cutoff = now - DAY_MS;
    const trades = this.coinTrades(coinId);
    let volume = 0;
    for (let i = trades.length - 1; i >= 0 && ts(trades[i].createdAt) >= cutoff; i--) volume += trades[i].usdc;
    return volume;
  }

  /**
   * Relative price change versus 24 hours ago (0.25 = +25%). The reference is
   * the price after the latest trade at or before the cutoff, or the launch
   * price when the coin had not traded by then.
   */
  private change24h(coin: Coin, price: number, now: number): number {
    const cutoff = now - DAY_MS;
    let reference = launchPrice(coin);
    for (const t of this.coinTrades(coin.id)) {
      if (ts(t.createdAt) > cutoff) break;
      reference = t.price;
    }
    return reference > 0 ? price / reference - 1 : 0;
  }

  private holderCount(coinId: number): number {
    let n = 0;
    for (const h of this.coinHoldings(coinId)) if (h.tokens > TOKEN_EPSILON) n++;
    return n;
  }

  private withUser(t: Trade): Trade & { user: PublicUser } {
    return { ...t, user: this.toPublicUser(t.userId) };
  }

  private summarize(coin: Coin, now = Date.now()): CoinSummary {
    const state = curveOf(coin);
    const price = curve.spotPrice(state);
    const marketCap = curve.marketCap(state);
    const trades = this.coinTrades(coin.id);
    const last = trades.length ? trades[trades.length - 1] : null;
    return {
      ...coin,
      price,
      marketCap,
      progress: clamp(marketCap / GRADUATION_MCAP, 0, 1),
      holders: this.holderCount(coin.id),
      comments: this.coinComments(coin.id).length,
      change24h: this.change24h(coin, price, now),
      creator: this.toPublicUser(coin.creatorId),
      lastTrade: last ? this.withUser(last) : null,
    };
  }

  private detail(coin: Coin, viewerId?: number): CoinDetail {
    const trades = this.coinTrades(coin.id);
    const recentTrades: (Trade & { user: PublicUser })[] = [];
    for (let i = trades.length - 1; i >= 0 && recentTrades.length < RECENT_TRADES; i--) recentTrades.push(this.withUser(trades[i]));

    const commentsList = this.coinComments(coin.id)
      .slice()
      .sort(newestFirst)
      .map((c) => this.toCommentView(c));

    const topHolders: HolderRow[] = this.coinHoldings(coin.id)
      .filter((h) => h.tokens > TOKEN_EPSILON)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_HOLDERS)
      .map((h) => ({
        user: this.toPublicUser(h.userId),
        tokens: h.tokens,
        share: h.tokens / TOTAL_SUPPLY,
        isCreator: h.userId === coin.creatorId,
      }));

    const mine = viewerId !== undefined ? this.findHolding(viewerId, coin.id) : undefined;
    return {
      ...this.summarize(coin),
      candles: this.getCandles(coin.id),
      recentTrades,
      commentsList,
      topHolders,
      myHolding: mine && mine.tokens > TOKEN_EPSILON ? { ...mine } : null,
    };
  }

  private matchesSearch(c: Coin, needle: string): boolean {
    return (
      c.name.toLowerCase().includes(needle) ||
      c.ticker.toLowerCase().includes(needle) ||
      c.ca.toLowerCase() === needle ||
      c.description.toLowerCase().includes(needle)
    );
  }

  // -------------------------------------------------------------------------
  // Coins: queries
  // -------------------------------------------------------------------------

  listCoins(filters: CoinListFilters = {}): CoinSummary[] {
    const now = Date.now();
    const sort = filters.sort ?? "new";
    const needle = filters.search?.trim().toLowerCase();
    const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : DEFAULT_LIST_LIMIT;

    const list: CoinSummary[] = [];
    for (const c of this.state.coins) {
      if (filters.creatorId !== undefined && c.creatorId !== filters.creatorId) continue;
      if (sort === "graduated" && !c.graduated) continue;
      if (needle && !this.matchesSearch(c, needle)) continue;
      list.push(this.summarize(c, now));
    }

    switch (sort) {
      case "new":
        list.sort(newestFirst);
        break;
      case "mcap":
        list.sort((a, b) => b.marketCap - a.marketCap || newestFirst(a, b));
        break;
      case "volume":
        list.sort((a, b) => b.volume - a.volume || newestFirst(a, b));
        break;
      case "graduated":
        list.sort((a, b) => ts(b.graduatedAt ?? b.createdAt) - ts(a.graduatedAt ?? a.createdAt) || b.id - a.id);
        break;
      case "trending": {
        // 24h volume, boosted for coins launched in the last day so fresh launches surface.
        const score = new Map<number, number>();
        for (const s of list) {
          const ageHours = Math.max(0, now - ts(s.createdAt)) / HOUR_MS;
          const boost = 1 + Math.max(0, 1 - ageHours / 24);
          score.set(s.id, this.volume24h(s.id, now) * boost);
        }
        list.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || b.marketCap - a.marketCap || newestFirst(a, b));
        break;
      }
    }
    return list.slice(0, limit);
  }

  /**
   * King of the Hill: the non-graduated coin with the highest market cap, provided
   * it is at or above KING_MCAP — otherwise simply the highest-cap open coin.
   * Null when there are no open coins at all.
   */
  getKing(): CoinSummary | null {
    let best: Coin | null = null;
    let bestCap = -1;
    for (const c of this.state.coins) {
      if (c.graduated) continue;
      const cap = curve.marketCap(curveOf(c));
      if (cap > bestCap) {
        best = c;
        bestCap = cap;
      }
    }
    // KING_MCAP only changes how the client badges the coin; the top open coin is returned either way.
    return best ? this.summarize(best) : null;
  }

  /** Full coin page. `viewerId` fills `myHolding`. */
  getCoinByCa(ca: string, viewerId?: number): CoinDetail | undefined {
    const coin = this.coinsByCa.get(ca.trim());
    if (!coin) return undefined;
    return this.detail(coin, viewerId);
  }

  /**
   * 1-minute OHLC candles (USDC per token) derived from the coin's trades, starting
   * with a synthetic launch candle at the creation price. Cached until the next trade.
   */
  getCandles(coinId: number): Candle[] {
    const coin = this.mustCoin(coinId);
    let candles = this.candleCache.get(coinId);
    if (!candles) {
      candles = this.buildCandles(coin);
      this.candleCache.set(coinId, candles);
    }
    return candles.map((c) => ({ ...c }));
  }

  private buildCandles(coin: Coin): Candle[] {
    const launch = launchPrice(coin);
    const candles: Candle[] = [{ t: bucketStart(ts(coin.createdAt)), o: launch, h: launch, l: launch, c: launch, v: 0 }];
    for (const t of this.coinTrades(coin.id)) {
      const bucket = bucketStart(ts(t.createdAt));
      const last = candles[candles.length - 1];
      if (bucket <= last.t) {
        // Same minute as the previous candle (or a clock hiccup): fold the trade in.
        last.h = Math.max(last.h, t.price);
        last.l = Math.min(last.l, t.price);
        last.c = t.price;
        last.v = round6(last.v + t.usdc);
      } else {
        candles.push({
          t: bucket,
          o: last.c,
          h: Math.max(last.c, t.price),
          l: Math.min(last.c, t.price),
          c: t.price,
          v: round6(t.usdc),
        });
      }
    }
    return candles;
  }

  // -------------------------------------------------------------------------
  // Coins: creation
  // -------------------------------------------------------------------------

  /**
   * Launches a coin: mints the creator allocation, optionally executes the creator's
   * first buy through the curve (paid from their balance) and records the launch.
   * `imageUrl` is the already-stored image (routes handle the upload).
   */
  createCoin(creator: User, input: CreateCoinInput, imageUrl: string): { coin: CoinDetail; trade: Trade | null } {
    const user = this.mustUser(creator.id);
    const allocation = clamp(Number(input.creatorAllocation) || 0, 0, 1);
    const initialBuy = round6(Math.max(0, Number(input.initialBuy) || 0));
    if (initialBuy > 0 && initialBuy < MIN_BUY_USDC) throw new HttpError(400, `Minimum initial buy is ${MIN_BUY_USDC} USDC`);
    if (initialBuy > user.balance + DUST) throw new HttpError(400, "Insufficient balance for the initial buy");

    const now = nowIso();
    const initial = curve.initialCurve(allocation);
    const coin = this.addCoin({
      id: this.nextId("coin"),
      ca: this.uniqueCa(),
      name: input.name.trim(),
      ticker: input.ticker.trim().toUpperCase(),
      description: input.description.trim(),
      imageUrl,
      website: optionalLink(input.website),
      twitter: optionalLink(input.twitter),
      telegram: optionalLink(input.telegram),
      creatorId: user.id,
      creatorAllocation: allocation,
      realUsdc: initial.realUsdc,
      curveTokens: initial.curveTokens,
      circulating: 0,
      volume: 0,
      buys: 0,
      sells: 0,
      feesCollected: 0,
      creatorFees: 0,
      graduated: false,
      graduatedAt: null,
      createdAt: now,
      lastTradeAt: null,
    });

    const minted = TOTAL_SUPPLY * allocation;
    if (minted > 0) {
      const holding = this.getOrCreateHolding(user.id, coin.id);
      holding.tokens += minted;
      coin.circulating += minted;
    }

    let trade: Trade | null = null;
    if (initialBuy > 0) {
      const swap = curve.quoteBuy(curveOf(coin), Math.min(initialBuy, round6(this.maxBuy(coin))));
      if (swap.amountOut > DUST) trade = this.settle(coin, user, "buy", swap, now);
    }

    this.persist();
    return { coin: this.detail(coin, user.id), trade };
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  private findHolding(userId: number, coinId: number): Holding | undefined {
    return this.holdingsByKey.get(holdingKey(userId, coinId));
  }

  private getOrCreateHolding(userId: number, coinId: number): Holding {
    const existing = this.findHolding(userId, coinId);
    if (existing) return existing;
    const created: Holding = { id: this.nextId("holding"), userId, coinId, tokens: 0, costBasis: 0, realizedPnl: 0 };
    this.state.holdings.push(created);
    this.indexHolding(created);
    return created;
  }

  /**
   * Largest buy (USDC, fee included) the curve can still fill, i.e. the cost of every
   * remaining token; 0 once the curve is sold out. Buys are capped to it so a trader
   * never pays for tokens the curve does not have.
   */
  private maxBuy(coin: Coin): number {
    if (coin.curveTokens <= TOKEN_EPSILON) return 0;
    return Math.max(0, curve.usdcForTokens(curveOf(coin), coin.curveTokens));
  }

  /** Validates an order and prices it against the current curve state. */
  private prepareSwap(coin: Coin, user: User, side: TradeSide, amount: number): curve.SwapResult {
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Amount must be a positive number");
    const state = curveOf(coin);
    let swap: curve.SwapResult;
    if (side === "buy") {
      const usdc = round6(amount);
      if (usdc < MIN_BUY_USDC) throw new HttpError(400, `Minimum buy is ${MIN_BUY_USDC} USDC`);
      if (usdc > user.balance + DUST) throw new HttpError(400, "Insufficient balance");
      const maxIn = round6(this.maxBuy(coin));
      if (maxIn < MIN_BUY_USDC) throw new HttpError(400, "The bonding curve is sold out");
      // A buy larger than what is left simply buys out the curve; the rest stays in the balance.
      swap = curve.quoteBuy(state, Math.min(usdc, maxIn));
    } else {
      const owned = this.findHolding(user.id, coin.id)?.tokens ?? 0;
      if (owned <= TOKEN_EPSILON) throw new HttpError(400, "You don't hold this coin");
      if (amount > owned * (1 + 1e-9) + DUST) throw new HttpError(400, "You don't own that many tokens");
      swap = curve.quoteSell(state, Math.min(amount, owned));
    }
    if (swap.amountOut <= DUST) throw new HttpError(400, "Trade too small");
    return swap;
  }

  private toQuote(side: TradeSide, swap: curve.SwapResult): TradeQuote {
    return {
      side,
      amountIn: swap.amountIn,
      amountOut: swap.amountOut,
      fee: swap.fee,
      priceBefore: swap.priceBefore,
      priceAfter: swap.priceAfter,
      priceImpact: swap.priceImpact,
      marketCapAfter: curve.marketCap(swap.next),
    };
  }

  /** Prices an order without executing it. `amount` is USDC for buys, tokens for sells. */
  quote(coinId: number, userId: number, side: TradeSide, amount: number): TradeQuote {
    const coin = this.mustCoin(coinId);
    const user = this.mustUser(userId);
    return this.toQuote(side, this.prepareSwap(coin, user, side, amount));
  }

  /**
   * Executes an order. `amount` is USDC to spend (fee included) for buys and tokens
   * to sell for sells. `minOut` is the slippage guard: minimum tokens (buy) or USDC
   * (sell) the trader accepts; a worse fill is rejected with 400 "Price moved".
   */
  trade(coinId: number, userId: number, side: TradeSide, amount: number, minOut?: number): { trade: Trade; coin: CoinSummary; user: User } {
    const coin = this.mustCoin(coinId);
    const user = this.mustUser(userId);
    const swap = this.prepareSwap(coin, user, side, amount);
    if (minOut !== undefined && Number.isFinite(minOut) && minOut > 0 && swap.amountOut < minOut) {
      throw new HttpError(400, "Price moved, try again");
    }
    const trade = this.settle(coin, user, side, swap, nowIso());
    this.persist();
    return { trade, coin: this.summarize(coin), user };
  }

  /**
   * Applies a priced swap to the ledger: trader balance and holding (average-cost
   * accounting), creator fee, platform revenue, curve state, coin statistics,
   * graduation and the trade log. Shared by live trading and the seed simulation.
   */
  private settle(coin: Coin, user: User, side: TradeSide, swap: curve.SwapResult, at: string): Trade {
    const holding = this.getOrCreateHolding(user.id, coin.id);
    let usdc: number;
    let tokens: number;

    if (side === "buy") {
      usdc = round6(swap.amountIn);
      tokens = swap.amountOut;
      user.balance = round6(user.balance - usdc);
      holding.tokens += tokens;
      holding.costBasis = round6(holding.costBasis + usdc);
      coin.circulating += tokens;
      coin.buys += 1;
    } else {
      tokens = swap.amountIn;
      usdc = round6(swap.amountOut);
      const fraction = holding.tokens > 0 ? Math.min(1, tokens / holding.tokens) : 1;
      const costOfSold = round6(holding.costBasis * fraction);
      user.balance = round6(user.balance + usdc);
      holding.realizedPnl = round6(holding.realizedPnl + usdc - costOfSold);
      holding.costBasis = round6(holding.costBasis - costOfSold);
      holding.tokens -= tokens;
      if (holding.tokens < TOKEN_EPSILON) {
        holding.tokens = 0;
        holding.costBasis = 0;
      }
      coin.circulating = Math.max(0, coin.circulating - tokens);
      coin.sells += 1;
    }

    // Fee split: the creator is paid instantly, the rest is platform revenue.
    const creator = this.usersById.get(coin.creatorId);
    if (creator && swap.creatorFee > 0) {
      creator.balance = round6(creator.balance + swap.creatorFee);
      creator.creatorEarnings = round6(creator.creatorEarnings + swap.creatorFee);
    }
    this.state.platformRevenue = round6(this.state.platformRevenue + swap.platformFee);

    coin.realUsdc = swap.next.realUsdc;
    coin.curveTokens = Math.max(0, swap.next.curveTokens);
    coin.volume = round6(coin.volume + usdc);
    coin.feesCollected = round6(coin.feesCollected + swap.fee);
    coin.creatorFees = round6(coin.creatorFees + swap.creatorFee);
    coin.lastTradeAt = at;

    const marketCap = curve.marketCap(swap.next);
    if (!coin.graduated && marketCap >= GRADUATION_MCAP) {
      coin.graduated = true;
      coin.graduatedAt = at;
    }

    const trade: Trade = {
      id: this.nextId("trade"),
      coinId: coin.id,
      userId: user.id,
      side,
      usdc,
      tokens,
      fee: swap.fee,
      price: swap.priceAfter,
      marketCap,
      createdAt: at,
    };
    this.state.trades.push(trade);
    this.indexTrade(trade);
    this.candleCache.delete(coin.id);
    return trade;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private toCommentView(c: Comment): CommentView {
    const holding = this.findHolding(c.userId, c.coinId);
    return { ...c, user: this.toPublicUser(c.userId), holding: holding && holding.tokens > TOKEN_EPSILON ? holding.tokens : 0 };
  }

  addComment(coinId: number, userId: number, body: string, imageUrl?: string | null): CommentView {
    const coin = this.mustCoin(coinId);
    this.mustUser(userId);
    const text = body.trim();
    if (!text) throw new HttpError(400, "Comment cannot be empty");
    const comment: Comment = {
      id: this.nextId("comment"),
      coinId: coin.id,
      userId,
      body: text,
      imageUrl: imageUrl ?? null,
      likes: [],
      createdAt: nowIso(),
    };
    this.state.comments.push(comment);
    this.indexComment(comment);
    this.persist();
    return this.toCommentView(comment);
  }

  toggleLike(commentId: number, userId: number): CommentView {
    const comment = this.commentsById.get(commentId);
    if (!comment) throw new HttpError(404, "Comment not found");
    this.mustUser(userId);
    const idx = comment.likes.indexOf(userId);
    if (idx === -1) comment.likes.push(userId);
    else comment.likes.splice(idx, 1);
    this.persist();
    return this.toCommentView(comment);
  }

  /** Contract address of the coin a comment belongs to (for WebSocket frames). */
  getCommentCoinCa(commentId: number): string | undefined {
    const comment = this.commentsById.get(commentId);
    return comment ? this.coinsById.get(comment.coinId)?.ca : undefined;
  }

  // -------------------------------------------------------------------------
  // Wallet
  // -------------------------------------------------------------------------

  getWallet(userId: number): WalletView {
    const user = this.mustUser(userId);
    return {
      balance: user.balance,
      depositAddress: user.depositAddress,
      deposits: this.state.deposits.filter((d) => d.userId === userId).sort(newestFirst),
      withdrawals: this.state.withdrawals.filter((w) => w.userId === userId).sort(newestFirst),
      chain: config.chain,
    };
  }

  /** Returns the stored deposit mnemonic, generating and persisting one on first use. */
  getOrCreateMnemonic(generate: () => string): string {
    if (this.state.mnemonic) return this.state.mnemonic;
    this.state.mnemonic = generate();
    this.persist();
    return this.state.mnemonic;
  }

  getLastScannedBlock(): number | null {
    return this.state.lastScannedBlock;
  }

  setLastScannedBlock(n: number): void {
    this.state.lastScannedBlock = n;
    this.persist();
  }

  /** Every address the deposit watcher should monitor (bots have none). */
  listDepositAddresses(): { address: string; userId: number }[] {
    return this.state.users.filter((u) => u.depositAddress !== "").map((u) => ({ address: u.depositAddress, userId: u.id }));
  }

  /** Credits a confirmed on-chain deposit exactly once per transaction hash. */
  recordDeposit(userId: number, txHash: string, amount: number, blockNumber: number): Deposit | null {
    const hash = txHash.toLowerCase();
    if (this.depositTxHashes.has(hash)) return null;
    const user = this.mustUser(userId);
    const deposit: Deposit = {
      id: this.nextId("deposit"),
      userId,
      txHash,
      amount: round6(amount),
      blockNumber,
      createdAt: nowIso(),
    };
    user.balance = round6(user.balance + deposit.amount);
    this.state.deposits.push(deposit);
    this.depositTxHashes.add(hash);
    this.persist();
    return deposit;
  }

  getWithdrawal(id: number): Withdrawal | undefined {
    return this.withdrawalsById.get(id);
  }

  /** Debits the balance immediately; the chain worker later marks the request sent or failed. */
  requestWithdrawal(userId: number, toAddress: string, amount: number): Withdrawal {
    const user = this.mustUser(userId);
    if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL_USDC) {
      throw new HttpError(400, `Minimum withdrawal is ${MIN_WITHDRAWAL_USDC} USDC`);
    }
    const usdc = round6(amount);
    if (usdc > user.balance + DUST) throw new HttpError(400, "Insufficient balance");

    const now = nowIso();
    const withdrawal: Withdrawal = {
      id: this.nextId("withdrawal"),
      userId,
      toAddress,
      amount: usdc,
      status: "pending",
      txHash: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    user.balance = round6(user.balance - usdc);
    this.state.withdrawals.push(withdrawal);
    this.withdrawalsById.set(withdrawal.id, withdrawal);
    this.persist();
    return withdrawal;
  }

  /** Updates a withdrawal's status; a transition into "failed" refunds the debited amount. */
  updateWithdrawal(id: number, patch: { status: WithdrawalStatus; txHash?: string | null; error?: string | null }): Withdrawal {
    const w = this.withdrawalsById.get(id);
    if (!w) throw new HttpError(404, "Withdrawal not found");
    if (patch.status === "failed" && w.status !== "failed") {
      const user = this.usersById.get(w.userId);
      if (user) user.balance = round6(user.balance + w.amount);
    }
    w.status = patch.status;
    if (patch.txHash !== undefined) w.txHash = patch.txHash;
    if (patch.error !== undefined) w.error = patch.error;
    w.updatedAt = nowIso();
    this.persist();
    return w;
  }

  listWithdrawals(status?: WithdrawalStatus): Withdrawal[] {
    return this.state.withdrawals.filter((w) => status === undefined || w.status === status).sort(newestFirst);
  }

  /** Testnet-only play money, at most once every ten minutes per user. */
  faucet(userId: number, amount = 1000): User {
    if (!config.chain.testnet) throw new HttpError(403, "Faucet is only available on testnets");
    const user = this.mustUser(userId);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Invalid faucet amount");

    const last = this.faucetClaims.get(userId);
    if (last !== undefined && Date.now() - last < FAUCET_COOLDOWN_MS) {
      const minutes = Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - last)) / MINUTE_MS);
      throw new HttpError(429, `Faucet already used, try again in ${minutes} min`);
    }
    this.faucetClaims.set(userId, Date.now());
    user.balance = round6(user.balance + amount);
    this.persist();
    return user;
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  getPortfolio(userId: number): Portfolio {
    const user = this.mustUser(userId);
    const now = Date.now();
    const summaries = new Map<number, CoinSummary>();
    const summaryOf = (c: Coin): CoinSummary => {
      let s = summaries.get(c.id);
      if (!s) {
        s = this.summarize(c, now);
        summaries.set(c.id, s);
      }
      return s;
    };

    let holdingsValue = 0;
    let unrealizedPnl = 0;
    let realizedPnl = 0;
    const holdings: PortfolioHolding[] = [];
    for (const h of this.state.holdings) {
      if (h.userId !== userId) continue;
      realizedPnl += h.realizedPnl;
      if (h.tokens <= TOKEN_EPSILON) continue;
      const coin = this.coinsById.get(h.coinId);
      if (!coin) continue;
      const summary = summaryOf(coin);
      const value = round6(summary.price * h.tokens);
      const pnl = round6(value - h.costBasis);
      holdingsValue += value;
      unrealizedPnl += pnl;
      holdings.push({ ...h, coin: summary, value, unrealizedPnl: pnl });
    }
    holdings.sort((a, b) => b.value - a.value);

    const trades: Portfolio["trades"] = [];
    for (const t of this.state.trades.filter((t) => t.userId === userId).sort(newestFirst)) {
      const coin = this.coinsById.get(t.coinId);
      if (!coin) continue;
      trades.push({ ...t, coin: coinRef(coin) });
    }

    const createdCoins = this.state.coins
      .filter((c) => c.creatorId === userId)
      .sort(newestFirst)
      .map((c) => summaryOf(c));

    holdingsValue = round6(holdingsValue);
    return {
      balance: user.balance,
      holdingsValue,
      totalValue: round6(user.balance + holdingsValue),
      realizedPnl: round6(realizedPnl),
      unrealizedPnl: round6(unrealizedPnl),
      creatorEarnings: user.creatorEarnings,
      holdings,
      trades,
      createdCoins,
    };
  }

  /** Latest trades across all coins, newest first. */
  getActivity(limit = 60): ActivityItem[] {
    const items: ActivityItem[] = [];
    for (const t of this.state.trades.slice().sort(newestFirst)) {
      const coin = this.coinsById.get(t.coinId);
      if (!coin) continue;
      items.push({ trade: t, user: this.toPublicUser(t.userId), coin: coinRef(coin) });
      if (items.length >= limit) break;
    }
    return items;
  }

  getStats(): PlatformStats {
    const traders = new Set<number>();
    let volume = 0;
    for (const t of this.state.trades) {
      traders.add(t.userId);
      volume += t.usdc;
    }
    return {
      coins: this.state.coins.length,
      volume: round6(volume),
      traders: traders.size,
      trades: this.state.trades.length,
    };
  }

  /** Public profile page data, or undefined when no such user exists. */
  getPublicProfile(username: string): { user: PublicUser; createdCoins: CoinSummary[]; joinedAt: string; holdingsCount: number } | undefined {
    const user = this.getUserByUsername(username);
    if (!user) return undefined;
    const now = Date.now();
    const createdCoins = this.state.coins
      .filter((c) => c.creatorId === user.id)
      .sort(newestFirst)
      .map((c) => this.summarize(c, now));
    let holdingsCount = 0;
    for (const h of this.state.holdings) if (h.userId === user.id && h.tokens > TOKEN_EPSILON) holdingsCount++;
    return { user: this.toPublicUser(user.id), createdCoins, joinedAt: user.createdAt, holdingsCount };
  }

  // -------------------------------------------------------------------------
  // Seed data (fresh deployments only)
  // -------------------------------------------------------------------------

  /**
   * Populates an empty state with bot traders and the demo coins from seed.ts,
   * including a simulated trading history so charts and feeds look alive.
   * Fully deterministic given the same clock, thanks to the seeded PRNG.
   */
  seed(): void {
    const now = Date.now();
    const rand = lcg(SEED_PRNG_SEED);
    const oldestCoinMs = Math.max(0, ...seedCoins.map((s) => s.ageHours)) * HOUR_MS + 7 * DAY_MS;

    const bots = seedBots.map((bot) =>
      this.addUser({
        id: this.nextId("user"),
        email: `${bot.name}@bots.noxia.local`,
        username: bot.name,
        avatarSeed: bot.name,
        avatarUrl: coinImageDataUrl(bot.emoji, bot.colors),
        provider: "email",
        walletAddress: null,
        isAdmin: false,
        balance: BOT_BALANCE,
        creatorEarnings: 0,
        depositIndex: -1,
        depositAddress: "",
        createdAt: iso(now - oldestCoinMs),
      }),
    );

    seedCoins.forEach((s, i) => this.seedCoin(s, bots, bots[i % bots.length], rand, now));
    log(`seeded ${this.state.coins.length} coins, ${this.state.trades.length} trades`, "storage");
    if (selloutMarketCap(0) < GRADUATION_MCAP) {
      log(
        `WARNING: with the current VIRTUAL_* reserves a coin sells out at a market cap of ${Math.round(selloutMarketCap(0))} USDC, ` +
          `below GRADUATION_MCAP (${GRADUATION_MCAP}) - no coin can ever graduate`,
        "storage",
      );
    }
    this.persist();
  }

  private seedCoin(s: SeedCoin, bots: User[], creator: User, rand: () => number, now: number): void {
    const createdMs = now - s.ageHours * HOUR_MS;
    const createdAt = iso(createdMs);
    const allocation = clamp(s.creatorAllocation, 0, 1);
    const initial = curve.initialCurve(allocation);
    const pickBot = (): User => bots[Math.floor(rand() * bots.length)];

    const coin = this.addCoin({
      id: this.nextId("coin"),
      ca: this.uniqueCa(),
      name: s.name,
      ticker: s.ticker,
      description: s.description,
      imageUrl: coinImageDataUrl(s.emoji, s.colors),
      website: s.website ?? null,
      twitter: s.twitter ?? null,
      telegram: s.telegram ?? null,
      creatorId: creator.id,
      creatorAllocation: allocation,
      realUsdc: initial.realUsdc,
      curveTokens: initial.curveTokens,
      circulating: 0,
      volume: 0,
      buys: 0,
      sells: 0,
      feesCollected: 0,
      creatorFees: 0,
      graduated: false,
      graduatedAt: null,
      createdAt,
      lastTradeAt: null,
    });
    const minted = TOTAL_SUPPLY * allocation;
    if (minted > 0) {
      this.getOrCreateHolding(creator.id, coin.id).tokens += minted;
      coin.circulating += minted;
    }

    // The story's final market cap is a fraction of the sold-out cap, so it is always reachable
    // whatever the VIRTUAL_* constants are; the real USDC needed for it follows from the invariant.
    const k = launchInvariant(allocation);
    const launchMcap = curve.marketCap(initial);
    const targetMcap = launchMcap + clamp(s.targetProgress, 0, 1) * (selloutMarketCap(allocation) - launchMcap);
    const targetUsdc = Math.max(0, Math.sqrt((targetMcap / TOTAL_SUPPLY) * k) - VIRTUAL_USDC_RESERVE);
    const shape = seedShape(s.shape ?? "steady");

    // Trades span the coin's life; the last one lands a couple of minutes before "now".
    const span = Math.max(MINUTE_MS, now - createdMs - 2 * MINUTE_MS);
    const steps = Math.max(1, Math.floor(s.trades));
    for (let step = 0; step < steps; step++) {
      const progress = (step + 1) / steps;
      const at = iso(createdMs + (span * (step + rand())) / steps);
      const noise = 1 + (rand() - 0.5) * 0.3;
      const pathUsdc = Math.max(0, targetUsdc * shape(progress) * noise);
      const diff = pathUsdc - coin.realUsdc;
      if (diff > 0) {
        const gross = clamp((diff / (1 - SWAP_FEE)) * (0.5 + rand()), 3, 5000);
        this.seedBuy(coin, pickBot(), gross, at);
      } else {
        const seller = this.seedPickSeller(coin, bots, rand);
        if (seller) {
          // Tokens that bring the curve back down to the path, then trimmed at random.
          const needed = k / (pathUsdc + VIRTUAL_USDC_RESERVE) - (coin.curveTokens + VIRTUAL_TOKEN_RESERVE);
          const tokens = Math.min(seller.holding.tokens, Math.max(0, needed) * (0.4 + rand() * 0.8));
          if (tokens > 1) this.seedSell(coin, seller.bot, tokens, at);
          else this.seedBuy(coin, pickBot(), 3 + rand() * 25, at);
        } else {
          this.seedBuy(coin, pickBot(), 3 + rand() * 25, at);
        }
      }
    }

    // Land on the story's market cap with one calibration trade a minute ago.
    const finalAt = iso(now - MINUTE_MS);
    const diff = targetUsdc - coin.realUsdc;
    if (diff > 0.01) {
      this.seedBuy(coin, pickBot(), diff / (1 - SWAP_FEE), finalAt);
    } else if (diff < -0.01) {
      const seller = this.seedPickSeller(coin, bots, rand);
      if (seller) {
        const needed = k / (targetUsdc + VIRTUAL_USDC_RESERVE) - (coin.curveTokens + VIRTUAL_TOKEN_RESERVE);
        const tokens = Math.min(seller.holding.tokens, Math.max(0, needed));
        if (tokens > 1) this.seedSell(coin, seller.bot, tokens, finalAt);
      }
    }

    for (const body of s.comments) {
      const comment: Comment = {
        id: this.nextId("comment"),
        coinId: coin.id,
        userId: pickBot().id,
        body,
        imageUrl: null,
        likes: [],
        createdAt: iso(createdMs + rand() * span),
      };
      const likers = Math.floor(rand() * 4);
      for (let i = 0; i < likers; i++) {
        const bot = pickBot();
        if (!comment.likes.includes(bot.id)) comment.likes.push(bot.id);
      }
      this.state.comments.push(comment);
      this.indexComment(comment);
    }
  }

  /** Seed-only buy of `gross` USDC (fee included). Mirrors trade() without validation; bots never run dry. */
  private seedBuy(coin: Coin, bot: User, gross: number, at: string): void {
    const usdc = round6(Math.min(gross, this.maxBuy(coin)));
    if (usdc < MIN_BUY_USDC) return;
    const swap = curve.quoteBuy(curveOf(coin), usdc);
    if (swap.amountOut <= DUST) return;
    this.settle(coin, bot, "buy", swap, at);
    bot.balance = Math.max(500, bot.balance);
  }

  /** Seed-only sale of `tokens` tokens by a bot that holds them. */
  private seedSell(coin: Coin, bot: User, tokens: number, at: string): void {
    const holding = this.findHolding(bot.id, coin.id);
    if (!holding || holding.tokens <= TOKEN_EPSILON) return;
    const amount = Math.min(tokens, holding.tokens);
    const swap = curve.quoteSell(curveOf(coin), amount);
    if (swap.amountOut <= DUST) return;
    this.settle(coin, bot, "sell", swap, at);
  }

  /** A random bot holding tokens of the coin, weighted towards the larger bags (never the creator's launch bag). */
  private seedPickSeller(coin: Coin, bots: User[], rand: () => number): { bot: User; holding: Holding } | null {
    const candidates: { bot: User; holding: Holding }[] = [];
    for (const bot of bots) {
      const holding = this.findHolding(bot.id, coin.id);
      // Creators keep their allocation in the demo data; they only sell what they bought.
      if (!holding || holding.tokens <= TOKEN_EPSILON || bot.id === coin.creatorId) continue;
      candidates.push({ bot, holding });
    }
    if (!candidates.length) return null;
    const total = candidates.reduce((sum, c) => sum + c.holding.tokens, 0);
    let r = rand() * total;
    for (const c of candidates) {
      r -= c.holding.tokens;
      if (r <= 0) return c;
    }
    return candidates[candidates.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers that need no instance state
// ---------------------------------------------------------------------------

/** Shape of a seeded coin's real-USDC path over its life, as a fraction of the final value. */
function seedShape(shape: NonNullable<SeedCoin["shape"]>): (p: number) => number {
  switch (shape) {
    case "pump":
      // Quiet accumulation, then a late vertical move.
      return (p) => Math.pow(p, 2.4);
    case "early":
      // Launch hype that fades into a plateau.
      return (p) => 1 - Math.pow(1 - p, 2.5);
    case "chop":
      // Grinds up with several visible pullbacks.
      return (p) => Math.max(0.02, p + 0.28 * Math.sin(p * Math.PI * 5) * (1 - p) * p * 2);
    case "dump":
      // Peaks around two thirds of the way in, then bleeds to the final level.
      return (p) => (p < 0.65 ? (2.2 * p) / 0.65 : 2.2 - (1.2 * (p - 0.65)) / 0.35);
    case "steady":
    default:
      return (p) => p;
  }
}

// ---------------------------------------------------------------------------
// Singleton & initialisation
// ---------------------------------------------------------------------------

export let storage: Storage;

/**
 * Creates the storage singleton, loads the persisted snapshot (or seeds demo
 * data when there is none) and wires up debounced persistence.
 *
 * `storage` is assigned before anything is loaded because chain.ts reaches
 * back into it (getOrCreateMnemonic) from `deriveDepositAddress`.
 */
export async function initStorage(opts: StorageOptions): Promise<Storage> {
  const instance = new Storage(opts);
  storage = instance;

  const backend = createBackend();
  const raw = await backend.load();
  if (raw) {
    instance.restore(raw);
    const s = instance.snapshot();
    log(`loaded state from ${backend.name}: ${s.users.length} users, ${s.coins.length} coins, ${s.trades.length} trades`, "storage");
  } else {
    log(`no snapshot in ${backend.name}, seeding demo data`, "storage");
    instance.seed();
  }

  instance.bindPersister(new Persister(backend, () => instance.snapshot()));
  if (config.initialCredits) instance.applyInitialCredits(config.initialCredits);
  return instance;
}
