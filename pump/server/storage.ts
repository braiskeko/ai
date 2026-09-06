/**
 * Noxia storage layer.
 *
 * Everything that is *not* on chain lives here: accounts, the coins we know
 * about, the trades the indexer has decoded, per-wallet cost basis and the
 * comment threads. The whole thing is one plain, JSON-serialisable object
 * (`State`) kept in memory and snapshotted (debounced) to a file or Postgres by
 * persistence.ts, so every read is a cheap synchronous lookup.
 *
 * The chain is always the source of truth for money: token balances, SOL
 * balances and claimable fees are read from RPC (see solana.ts). What we keep
 * here is the *history* (needed for candles, PnL and feeds), which cannot be
 * reconstructed from account state alone.
 *
 * Conventions:
 *  - timestamps are ISO-8601 strings
 *  - amounts are numbers in SOL or whole tokens (never lamports/base units)
 *  - coins are keyed by mint (`ca`), trades by transaction signature,
 *    holdings by (wallet, coinId)
 *  - candles are derived from trades and cached per coin
 */
import { randomUUID } from "crypto";
import {
  CANDLE_INTERVAL_MS,
  SOLANA_ADDRESS_RE,
  TOTAL_SUPPLY,
  type ActivityItem,
  type AuthProvider,
  type Candle,
  type Coin,
  type CoinDetail,
  type CoinSummary,
  type Comment,
  type CommentView,
  type CurveState,
  type Holding,
  type HolderRow,
  type PlatformStats,
  type Portfolio,
  type PortfolioHolding,
  type PublicUser,
  type SafeUser,
  type Trade,
  type User,
} from "@shared/schema";
import { config } from "./config";
import { createBackend, Persister } from "./persistence";
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
  creatorWallet?: string;
}

export type TradeSide = "buy" | "sell";

/** Everything the indexer knows about a pool it just read from the chain. */
export interface ChainCoinInput {
  ca: string;
  pool: string;
  name: string;
  ticker: string;
  metadataUri: string;
  creatorWallet: string;
  curve: CurveState;
  createdTx?: string;
  createdAt?: string;
  /** filled from our own metadata store when the coin was launched through Noxia */
  description?: string;
  imageUrl?: string;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
}

/** A swap the indexer decoded from a confirmed transaction. */
export interface TradeInput {
  coinId: number;
  signature: string;
  wallet: string;
  side: TradeSide;
  sol: number;
  tokens: number;
  feeSol: number;
  priceSol: number;
  slot: number;
  createdAt: string;
}

/** Next id to hand out for each entity type. */
interface IdCounters {
  user: number;
  coin: number;
  trade: number;
  comment: number;
}
type IdKind = keyof IdCounters;

/** The complete persisted application state. */
export interface State {
  version: 2;
  ids: IdCounters;
  users: User[];
  coins: Coin[];
  trades: Trade[];
  holdings: Holding[];
  comments: Comment[];
  /** pool address -> newest transaction signature already indexed */
  cursors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Holdings with fewer tokens than this are treated as empty. */
const TOKEN_EPSILON = 1e-6;
/** How many trades the coin page receives. */
const RECENT_TRADES = 200;
/** How many holders the coin page receives. */
const TOP_HOLDERS = 20;
const DEFAULT_LIST_LIMIT = 60;

const round9 = (n: number): number => Math.round(n * 1e9) / 1e9;
const nowIso = (): string => new Date().toISOString();
const ts = (isoString: string): number => Date.parse(isoString);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** Start of the 1-minute candle bucket containing `ms`. */
const bucketStart = (ms: number): number => Math.floor(ms / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

/** Newest first, ties broken by id so ordering is stable. */
function newestFirst<T extends { id: number; createdAt: string }>(a: T, b: T): number {
  return ts(b.createdAt) - ts(a.createdAt) || b.id - a.id;
}

function oldestFirst<T extends { id: number; createdAt: string }>(a: T, b: T): number {
  return ts(a.createdAt) - ts(b.createdAt) || a.id - b.id;
}

function holdingKey(wallet: string, coinId: number): string {
  return `${wallet}:${coinId}`;
}

/** "7xKX…noxia" — how an unnamed wallet is shown. */
export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function optionalLink(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function emptyCurve(): CurveState {
  return {
    quoteReserveSol: 0,
    baseReserve: TOTAL_SUPPLY,
    priceSol: 0,
    progress: 0,
    solToGraduate: 0,
    completed: false,
    migrated: false,
    dammPool: null,
    slot: 0,
  };
}

function coinRef(c: Coin): Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> {
  return { id: c.id, ca: c.ca, name: c.name, ticker: c.ticker, imageUrl: c.imageUrl };
}

function emptyState(): State {
  return {
    version: 2,
    ids: { user: 1, coin: 1, trade: 1, comment: 1 },
    users: [],
    coins: [],
    trades: [],
    holdings: [],
    comments: [],
    cursors: {},
  };
}

// ---------------------------------------------------------------------------
// Snapshot restore (defensive migration)
// ---------------------------------------------------------------------------

/** Shape of a snapshot as it may come back from disk: anything can be missing. */
interface LooseState {
  version?: number;
  ids?: Partial<IdCounters>;
  users?: Partial<User>[];
  coins?: Partial<Coin>[];
  trades?: Partial<Trade>[];
  holdings?: Partial<Holding>[];
  comments?: Partial<Comment>[];
  cursors?: Record<string, string>;
}

function withDefaults<T extends object>(defaults: T, loaded: Partial<T>): T {
  return { ...defaults, ...loaded };
}

/** Id counter that is safely above both the stored counter and every existing id. */
function nextIdAfter(items: { id: number }[], stored: number | undefined): number {
  const maxId = items.reduce((mx, it) => Math.max(mx, it.id), 0);
  return Math.max(stored ?? 1, maxId + 1);
}

export function restoreState(json: string): State {
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
        createdAt: now,
      },
      u,
    ),
  );

  const coins = (loose.coins ?? []).map((c) =>
    withDefaults<Coin>(
      {
        id: 0,
        ca: "",
        pool: "",
        name: "",
        ticker: "",
        description: "",
        imageUrl: "",
        metadataUri: "",
        website: null,
        twitter: null,
        telegram: null,
        creatorWallet: "",
        creatorId: null,
        curve: emptyCurve(),
        volumeSol: 0,
        buys: 0,
        sells: 0,
        feesSol: 0,
        createdAt: now,
        createdTx: "",
        lastTradeAt: null,
      },
      c,
    ),
  );
  // A curve object stored by an older build may be missing fields.
  for (const coin of coins) coin.curve = withDefaults(emptyCurve(), coin.curve ?? {});

  const trades = (loose.trades ?? []).map((t) =>
    withDefaults<Trade>(
      {
        id: 0,
        coinId: 0,
        signature: "",
        wallet: "",
        userId: null,
        side: "buy",
        sol: 0,
        tokens: 0,
        feeSol: 0,
        priceSol: 0,
        marketCapSol: 0,
        slot: 0,
        createdAt: now,
      },
      t,
    ),
  );

  const holdings = (loose.holdings ?? []).map((h) =>
    withDefaults<Holding>({ wallet: "", coinId: 0, tokens: 0, costBasisSol: 0, realizedPnlSol: 0 }, h),
  );

  const comments = (loose.comments ?? []).map((c) =>
    withDefaults<Comment>({ id: 0, coinId: 0, userId: 0, body: "", imageUrl: null, likes: [], createdAt: now }, c),
  );

  return {
    version: 2,
    ids: {
      user: nextIdAfter(users, loose.ids?.user),
      coin: nextIdAfter(coins, loose.ids?.coin),
      trade: nextIdAfter(trades, loose.ids?.trade),
      comment: nextIdAfter(comments, loose.ids?.comment),
    },
    users,
    coins,
    trades,
    holdings,
    comments,
    cursors: loose.cursors ?? {},
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
  /** wallet address (base58, case sensitive) -> user */
  private usersByWallet = new Map<string, User>();
  private coinsById = new Map<number, Coin>();
  private coinsByCa = new Map<string, Coin>();
  private coinsByPool = new Map<string, Coin>();
  private holdingsByKey = new Map<string, Holding>();
  private holdingsByCoin = new Map<number, Holding[]>();
  /** coin id -> trades in chronological order */
  private tradesByCoin = new Map<number, Trade[]>();
  private commentsByCoin = new Map<number, Comment[]>();
  private commentsById = new Map<number, Comment>();
  private signatures = new Set<string>();

  /** coin id -> derived 1-minute candles; dropped whenever the coin trades. */
  private candleCache = new Map<number, Candle[]>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  restore(json: string): void {
    this.state = restoreState(json);
    this.rebuildIndexes();
  }

  bindPersister(persister: Persister): void {
    this.persister = persister;
    persister.schedule();
  }

  /** The live state object. Callers must treat it as read-only. */
  snapshot(): State {
    return this.state;
  }

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
    this.coinsByPool.clear();
    this.holdingsByKey.clear();
    this.holdingsByCoin.clear();
    this.tradesByCoin.clear();
    this.commentsByCoin.clear();
    this.commentsById.clear();
    this.signatures.clear();
    this.candleCache.clear();
    for (const u of this.state.users) this.indexUser(u);
    for (const c of this.state.coins) this.indexCoin(c);
    for (const h of this.state.holdings) this.indexHolding(h);
    for (const t of this.state.trades.slice().sort(oldestFirst)) this.indexTrade(t);
    for (const c of this.state.comments) this.indexComment(c);
  }

  private indexUser(u: User): void {
    this.usersById.set(u.id, u);
    this.usersByEmail.set(u.email.toLowerCase(), u);
    if (u.walletAddress) this.usersByWallet.set(u.walletAddress, u);
  }

  private indexCoin(c: Coin): void {
    this.coinsById.set(c.id, c);
    this.coinsByCa.set(c.ca, c);
    if (c.pool) this.coinsByPool.set(c.pool, c);
  }

  private indexHolding(h: Holding): void {
    this.holdingsByKey.set(holdingKey(h.wallet, h.coinId), h);
    let list = this.holdingsByCoin.get(h.coinId);
    if (!list) {
      list = [];
      this.holdingsByCoin.set(h.coinId, list);
    }
    list.push(h);
  }

  private indexTrade(t: Trade): void {
    this.signatures.add(t.signature);
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

  /** Solana addresses are base58 and case sensitive: no normalisation here. */
  getUserByWallet(address: string): User | undefined {
    if (typeof address !== "string") return undefined;
    return this.usersByWallet.get(address.trim());
  }

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
   * listed in ADMIN_EMAILS and, when that list is empty, to the very first
   * account on the deployment so a fresh install always has an administrator.
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
   * Sign-in with a Solana wallet. The account is keyed by the base58 address;
   * its email is the synthetic `${address}@wallet.local` and the handle is
   * derived from the address ("7xKXtg…9f3c" -> "7xkx_9f3c", made unique).
   */
  findOrCreateWalletUser(address: string): { user: User; created: boolean } {
    const wallet = address.trim();
    if (!SOLANA_ADDRESS_RE.test(wallet)) throw new HttpError(400, "Invalid wallet address");
    const email = `${wallet.toLowerCase()}@wallet.local`;

    const existing = this.usersByWallet.get(wallet) ?? this.getUserByEmail(email);
    if (existing) {
      if (existing.walletAddress !== wallet) {
        existing.walletAddress = wallet;
        this.usersByWallet.set(wallet, existing);
        this.persist();
      }
      return { user: existing, created: false };
    }

    const user = this.createUser({
      email,
      provider: "wallet",
      preferredUsername: `${wallet.slice(0, 4)}_${wallet.slice(-4)}`.toLowerCase(),
      walletAddress: wallet,
    });
    return { user, created: true };
  }

  /**
   * Links a wallet to an existing (email / Google / Apple) account so social
   * users can trade. A wallet belongs to exactly one account.
   */
  linkWallet(userId: number, address: string): User {
    const wallet = address.trim();
    if (!SOLANA_ADDRESS_RE.test(wallet)) throw new HttpError(400, "Invalid wallet address");
    const owner = this.usersByWallet.get(wallet);
    if (owner && owner.id !== userId) throw new HttpError(409, "That wallet is already linked to another account");
    const user = this.mustUser(userId);
    if (user.walletAddress && user.walletAddress !== wallet) this.usersByWallet.delete(user.walletAddress);
    user.walletAddress = wallet;
    this.usersByWallet.set(wallet, user);
    this.claimCoinsFor(user);
    this.persist();
    return user;
  }

  /** Attributes coins and trades already indexed for a wallet to its new owner. */
  private claimCoinsFor(user: User): void {
    if (!user.walletAddress) return;
    for (const coin of this.state.coins) {
      if (coin.creatorId === null && coin.creatorWallet === user.walletAddress) coin.creatorId = user.id;
    }
    for (const trade of this.state.trades) {
      if (trade.userId === null && trade.wallet === user.walletAddress) trade.userId = user.id;
    }
  }

  private createUser(input: {
    email: string;
    provider: AuthProvider;
    preferredUsername: string;
    walletAddress: string | null;
  }): User {
    const listedAdmin = config.adminEmails.includes(input.email);
    const bootstrapAdmin = config.adminEmails.length === 0 && this.state.users.length === 0;

    const user: User = {
      id: this.nextId("user"),
      email: input.email,
      username: this.uniqueUsername(input.preferredUsername),
      avatarSeed: randomUUID(),
      avatarUrl: null,
      provider: input.provider,
      walletAddress: input.walletAddress,
      isAdmin: listedAdmin || bootstrapAdmin,
      createdAt: nowIso(),
    };
    this.state.users.push(user);
    this.indexUser(user);
    if (bootstrapAdmin) log(`${input.email} is the first account on this deployment and was granted admin`, "storage");
    this.claimCoinsFor(user);
    this.persist();
    return user;
  }

  /** Admin listing, newest first, optional substring filter over handle/email/wallet. */
  listUsers(search = "", limit = 50): SafeUser[] {
    const needle = search.trim().replace(/^@/, "").toLowerCase();
    return this.state.users
      .filter(
        (u) =>
          !needle ||
          u.username.toLowerCase().includes(needle) ||
          u.email.includes(needle) ||
          (u.walletAddress?.toLowerCase().includes(needle) ?? false),
      )
      .sort(newestFirst)
      .slice(0, limit)
      .map((u) => this.toSafeUser(u));
  }

  /** Sanitises a preferred handle to [a-zA-Z0-9_], 3-24 chars, and makes it unique. */
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
    this.persist();
    return user;
  }

  setAvatar(userId: number, imageUrl: string | null): User {
    const user = this.mustUser(userId);
    user.avatarUrl = imageUrl;
    this.persist();
    return user;
  }

  /** Nothing is stripped any more (no balances, no deposit index), but keep the seam. */
  toSafeUser(u: User): SafeUser {
    return { ...u };
  }

  toPublicUser(id: number | null): PublicUser | null {
    if (id === null) return null;
    const u = this.usersById.get(id);
    if (!u) return null;
    return { id: u.id, username: u.username, avatarSeed: u.avatarSeed, avatarUrl: u.avatarUrl, walletAddress: u.walletAddress };
  }

  /** A user for `wallet`, or a synthetic "anonymous wallet" profile. */
  publicUserForWallet(wallet: string, userId: number | null = null): PublicUser {
    const known = this.toPublicUser(userId) ?? (wallet ? this.toPublicUser(this.getUserByWallet(wallet)?.id ?? null) : null);
    if (known) return known;
    return { id: 0, username: shortAddress(wallet), avatarSeed: wallet || "unknown", avatarUrl: null, walletAddress: wallet || null };
  }

  // -------------------------------------------------------------------------
  // Coins
  // -------------------------------------------------------------------------

  findCoinByCa(ca: string): Coin | undefined {
    return this.coinsByCa.get(ca.trim());
  }

  findCoinByPool(pool: string): Coin | undefined {
    return this.coinsByPool.get(pool.trim());
  }

  getCoin(id: number): Coin | undefined {
    return this.coinsById.get(id);
  }

  private mustCoin(id: number): Coin {
    const c = this.coinsById.get(id);
    if (!c) throw new HttpError(404, "Coin not found");
    return c;
  }

  /**
   * Adds or refreshes a coin from what the indexer read on chain. Only fields the
   * chain owns are overwritten; description/image/links stay as they were unless
   * the caller passes new ones (they come from our own metadata store).
   */
  upsertCoinFromChain(input: ChainCoinInput): { coin: Coin; created: boolean } {
    const existing = this.coinsByCa.get(input.ca);
    if (existing) {
      existing.pool = input.pool;
      existing.name = input.name || existing.name;
      existing.ticker = input.ticker || existing.ticker;
      existing.metadataUri = input.metadataUri || existing.metadataUri;
      existing.creatorWallet = input.creatorWallet || existing.creatorWallet;
      if (existing.creatorId === null) existing.creatorId = this.getUserByWallet(existing.creatorWallet)?.id ?? null;
      if (input.description !== undefined) existing.description = input.description;
      if (input.imageUrl !== undefined) existing.imageUrl = input.imageUrl;
      if (input.website !== undefined) existing.website = optionalLink(input.website);
      if (input.twitter !== undefined) existing.twitter = optionalLink(input.twitter);
      if (input.telegram !== undefined) existing.telegram = optionalLink(input.telegram);
      if (input.createdTx && !existing.createdTx) existing.createdTx = input.createdTx;
      this.coinsByPool.set(existing.pool, existing);
      this.setCurve(existing, input.curve);
      return { coin: existing, created: false };
    }

    const coin: Coin = {
      id: this.nextId("coin"),
      ca: input.ca,
      pool: input.pool,
      name: input.name || input.ticker || shortAddress(input.ca),
      ticker: input.ticker,
      description: input.description ?? "",
      imageUrl: input.imageUrl ?? "",
      metadataUri: input.metadataUri,
      website: optionalLink(input.website),
      twitter: optionalLink(input.twitter),
      telegram: optionalLink(input.telegram),
      creatorWallet: input.creatorWallet,
      creatorId: this.getUserByWallet(input.creatorWallet)?.id ?? null,
      curve: input.curve,
      volumeSol: 0,
      buys: 0,
      sells: 0,
      feesSol: 0,
      createdAt: input.createdAt ?? nowIso(),
      createdTx: input.createdTx ?? "",
      lastTradeAt: null,
    };
    this.state.coins.push(coin);
    this.indexCoin(coin);
    this.persist();
    return { coin, created: true };
  }

  /** Writes a fresh curve reading. Returns true when the coin just graduated. */
  setCurve(coin: Coin, curve: CurveState): boolean {
    const wasCompleted = coin.curve.completed;
    coin.curve = curve;
    this.candleCache.delete(coin.id);
    this.persist();
    return !wasCompleted && curve.completed;
  }

  /** Metadata edits that come from our own store rather than the chain. */
  applyLocalMetadata(
    ca: string,
    meta: { description?: string; imageUrl?: string; website?: string | null; twitter?: string | null; telegram?: string | null },
  ): void {
    const coin = this.coinsByCa.get(ca);
    if (!coin) return;
    if (meta.description !== undefined) coin.description = meta.description;
    if (meta.imageUrl !== undefined) coin.imageUrl = meta.imageUrl;
    if (meta.website !== undefined) coin.website = optionalLink(meta.website);
    if (meta.twitter !== undefined) coin.twitter = optionalLink(meta.twitter);
    if (meta.telegram !== undefined) coin.telegram = optionalLink(meta.telegram);
    this.persist();
  }

  /** Volume (SOL) traded in the last 24 hours. Trades are chronological. */
  private volume24h(coinId: number, now: number): number {
    const cutoff = now - DAY_MS;
    const trades = this.coinTrades(coinId);
    let volume = 0;
    for (let i = trades.length - 1; i >= 0 && ts(trades[i].createdAt) >= cutoff; i--) volume += trades[i].sol;
    return volume;
  }

  /**
   * Relative price change versus 24 hours ago (0.25 = +25%). The reference is the
   * price after the newest trade at or before the cutoff; coins that had not
   * traded by then are measured from their first known price.
   */
  private change24h(coin: Coin, price: number, now: number): number {
    const cutoff = now - DAY_MS;
    const trades = this.coinTrades(coin.id);
    if (trades.length === 0) return 0;
    let reference = trades[0].priceSol;
    for (const t of trades) {
      if (ts(t.createdAt) > cutoff) break;
      reference = t.priceSol;
    }
    return reference > 0 ? price / reference - 1 : 0;
  }

  /** Wallets our index believes still hold tokens of the coin. */
  private holderCount(coinId: number): number {
    let n = 0;
    for (const h of this.coinHoldings(coinId)) if (h.tokens > TOKEN_EPSILON) n++;
    return n;
  }

  private withUser(t: Trade): Trade & { user: PublicUser | null } {
    return { ...t, user: this.toPublicUser(t.userId) };
  }

  summarize(coin: Coin, now = Date.now()): CoinSummary {
    const trades = this.coinTrades(coin.id);
    const last = trades.length ? trades[trades.length - 1] : null;
    const priceSol = coin.curve.priceSol;
    return {
      ...coin,
      priceSol,
      marketCapSol: priceSol * TOTAL_SUPPLY,
      progress: clamp(coin.curve.progress, 0, 1),
      holders: this.holderCount(coin.id),
      comments: this.coinComments(coin.id).length,
      change24h: this.change24h(coin, priceSol, now),
      creator: this.publicUserForWallet(coin.creatorWallet, coin.creatorId),
      lastTrade: last ? this.withUser(last) : null,
    };
  }

  /**
   * The coin page. `viewerWallet` fills `myHolding` from the indexed cost basis;
   * routes.ts overlays the chain balance and the real top-holder list.
   */
  getCoinDetail(ca: string, viewerWallet?: string | null): CoinDetail | undefined {
    const coin = this.coinsByCa.get(ca.trim());
    if (!coin) return undefined;

    const trades = this.coinTrades(coin.id);
    const recentTrades: (Trade & { user: PublicUser | null })[] = [];
    for (let i = trades.length - 1; i >= 0 && recentTrades.length < RECENT_TRADES; i--) recentTrades.push(this.withUser(trades[i]));

    const commentsList = this.coinComments(coin.id)
      .slice()
      .sort(newestFirst)
      .map((c) => this.toCommentView(c));

    const topHolders: HolderRow[] = this.coinHoldings(coin.id)
      .filter((h) => h.tokens > TOKEN_EPSILON)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_HOLDERS)
      .map((h) => this.holderRow(coin, h.wallet, h.tokens));

    const mine = viewerWallet ? this.findHolding(viewerWallet, coin.id) : undefined;
    return {
      ...this.summarize(coin),
      candles: this.getCandles(coin.id),
      recentTrades,
      commentsList,
      topHolders,
      myHolding: mine && (mine.tokens > TOKEN_EPSILON || mine.costBasisSol > 0) ? { ...mine } : null,
      creatorClaimableSol: 0,
    };
  }

  /** One row of the holders table (`isCurve` is set by the caller for the vault). */
  holderRow(coin: Coin, wallet: string, tokens: number, isCurve = false): HolderRow {
    const user = this.getUserByWallet(wallet);
    return {
      wallet,
      user: user ? this.toPublicUser(user.id) : null,
      tokens,
      share: TOTAL_SUPPLY > 0 ? tokens / TOTAL_SUPPLY : 0,
      isCreator: wallet === coin.creatorWallet,
      isCurve,
    };
  }

  private matchesSearch(c: Coin, needle: string): boolean {
    return (
      c.name.toLowerCase().includes(needle) ||
      c.ticker.toLowerCase().includes(needle) ||
      c.ca.toLowerCase() === needle ||
      c.pool.toLowerCase() === needle ||
      c.description.toLowerCase().includes(needle)
    );
  }

  listCoins(filters: CoinListFilters = {}): CoinSummary[] {
    const now = Date.now();
    const sort = filters.sort ?? "new";
    const needle = filters.search?.trim().toLowerCase();
    const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : DEFAULT_LIST_LIMIT;

    const list: CoinSummary[] = [];
    for (const c of this.state.coins) {
      if (filters.creatorWallet !== undefined && c.creatorWallet !== filters.creatorWallet) continue;
      if (sort === "graduated" && !c.curve.completed) continue;
      if (needle && !this.matchesSearch(c, needle)) continue;
      list.push(this.summarize(c, now));
    }

    switch (sort) {
      case "new":
        list.sort(newestFirst);
        break;
      case "mcap":
        list.sort((a, b) => b.marketCapSol - a.marketCapSol || newestFirst(a, b));
        break;
      case "volume":
        list.sort((a, b) => b.volumeSol - a.volumeSol || newestFirst(a, b));
        break;
      case "graduated":
        list.sort((a, b) => b.progress - a.progress || newestFirst(a, b));
        break;
      case "trending": {
        // 24h volume, boosted for coins launched in the last day so fresh launches surface.
        const score = new Map<number, number>();
        for (const s of list) {
          const ageHours = Math.max(0, now - ts(s.createdAt)) / HOUR_MS;
          const boost = 1 + Math.max(0, 1 - ageHours / 24);
          score.set(s.id, this.volume24h(s.id, now) * boost);
        }
        list.sort(
          (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || b.marketCapSol - a.marketCapSol || newestFirst(a, b),
        );
        break;
      }
    }
    return list.slice(0, limit);
  }

  /**
   * 1-minute OHLC candles (SOL per token) derived from the coin's trades.
   * Cached until the coin trades again or its curve state is refreshed.
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
    const trades = this.coinTrades(coin.id);
    if (trades.length === 0) {
      const price = coin.curve.priceSol;
      return [{ t: bucketStart(ts(coin.createdAt)), o: price, h: price, l: price, c: price, v: 0 }];
    }
    // Launch candle so the chart starts at the coin's creation, at the first traded price.
    const launch = trades[0].priceSol;
    const candles: Candle[] = [{ t: bucketStart(ts(coin.createdAt)), o: launch, h: launch, l: launch, c: launch, v: 0 }];
    for (const t of trades) {
      const bucket = bucketStart(ts(t.createdAt));
      const last = candles[candles.length - 1];
      if (bucket <= last.t) {
        // Same minute as the previous candle (or a clock hiccup): fold the trade in.
        last.h = Math.max(last.h, t.priceSol);
        last.l = Math.min(last.l, t.priceSol);
        last.c = t.priceSol;
        last.v = round9(last.v + t.sol);
      } else {
        candles.push({
          t: bucket,
          o: last.c,
          h: Math.max(last.c, t.priceSol),
          l: Math.min(last.c, t.priceSol),
          c: t.priceSol,
          v: round9(t.sol),
        });
      }
    }
    return candles;
  }

  // -------------------------------------------------------------------------
  // Trades & holdings
  // -------------------------------------------------------------------------

  findHolding(wallet: string, coinId: number): Holding | undefined {
    return this.holdingsByKey.get(holdingKey(wallet, coinId));
  }

  private getOrCreateHolding(wallet: string, coinId: number): Holding {
    const existing = this.findHolding(wallet, coinId);
    if (existing) return existing;
    const created: Holding = { wallet, coinId, tokens: 0, costBasisSol: 0, realizedPnlSol: 0 };
    this.state.holdings.push(created);
    this.indexHolding(created);
    return created;
  }

  hasSignature(signature: string): boolean {
    return this.signatures.has(signature);
  }

  /**
   * Records a swap the indexer decoded. Returns null when the signature was
   * already indexed (the indexer, the log subscription and /api/tx/send all
   * race to be first).
   */
  recordTrade(input: TradeInput): { trade: Trade; coin: Coin } | null {
    if (this.signatures.has(input.signature)) return null;
    const coin = this.mustCoin(input.coinId);
    const wallet = input.wallet;
    const user = wallet ? this.getUserByWallet(wallet) : undefined;

    const sol = round9(Math.max(0, input.sol));
    const tokens = Math.max(0, input.tokens);
    const holding = this.getOrCreateHolding(wallet, coin.id);

    if (input.side === "buy") {
      holding.tokens += tokens;
      holding.costBasisSol = round9(holding.costBasisSol + sol);
      coin.buys += 1;
    } else {
      const fraction = holding.tokens > 0 ? Math.min(1, tokens / holding.tokens) : 1;
      const costOfSold = round9(holding.costBasisSol * fraction);
      holding.realizedPnlSol = round9(holding.realizedPnlSol + sol - costOfSold);
      holding.costBasisSol = round9(Math.max(0, holding.costBasisSol - costOfSold));
      holding.tokens = Math.max(0, holding.tokens - tokens);
      if (holding.tokens < TOKEN_EPSILON) {
        holding.tokens = 0;
        holding.costBasisSol = 0;
      }
      coin.sells += 1;
    }

    coin.volumeSol = round9(coin.volumeSol + sol);
    coin.feesSol = round9(coin.feesSol + input.feeSol);
    coin.lastTradeAt = input.createdAt;

    const trade: Trade = {
      id: this.nextId("trade"),
      coinId: coin.id,
      signature: input.signature,
      wallet,
      userId: user?.id ?? null,
      side: input.side,
      sol,
      tokens,
      feeSol: round9(input.feeSol),
      priceSol: input.priceSol,
      marketCapSol: input.priceSol * TOTAL_SUPPLY,
      slot: input.slot,
      createdAt: input.createdAt,
    };
    this.state.trades.push(trade);
    this.indexTrade(trade);
    // Trades arrive newest-last in normal operation, but a backfill can insert
    // older ones; keep the per-coin list chronological for the candle builder.
    const list = this.tradesByCoin.get(coin.id);
    if (list && list.length > 1 && ts(list[list.length - 2].createdAt) > ts(trade.createdAt)) list.sort(oldestFirst);
    this.candleCache.delete(coin.id);
    this.persist();
    return { trade, coin };
  }

  // -------------------------------------------------------------------------
  // Indexer cursors
  // -------------------------------------------------------------------------

  getCursor(pool: string): string | undefined {
    return this.state.cursors[pool];
  }

  setCursor(pool: string, signature: string): void {
    this.state.cursors[pool] = signature;
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private toCommentView(c: Comment): CommentView {
    const user = this.usersById.get(c.userId);
    const wallet = user?.walletAddress ?? null;
    const holding = wallet ? this.findHolding(wallet, c.coinId) : undefined;
    return {
      ...c,
      user: this.toPublicUser(c.userId) ?? { id: c.userId, username: "unknown", avatarSeed: "unknown", avatarUrl: null, walletAddress: null },
      holding: holding && holding.tokens > TOKEN_EPSILON ? holding.tokens : 0,
    };
  }

  listComments(coinId: number): CommentView[] {
    return this.coinComments(coinId)
      .slice()
      .sort(newestFirst)
      .map((c) => this.toCommentView(c));
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

  /** Mint of the coin a comment belongs to (for WebSocket frames). */
  getCommentCoinCa(commentId: number): string | undefined {
    const comment = this.commentsById.get(commentId);
    return comment ? this.coinsById.get(comment.coinId)?.ca : undefined;
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  /**
   * Portfolio of a wallet, from the indexed history. `balanceSol`,
   * `creatorClaimableSol` and the exact token balances come from the chain and
   * are filled in by routes.ts.
   */
  getPortfolio(wallet: string | null): Portfolio {
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

    let holdingsValueSol = 0;
    let unrealizedPnlSol = 0;
    let realizedPnlSol = 0;
    const holdings: PortfolioHolding[] = [];
    if (wallet) {
      for (const h of this.state.holdings) {
        if (h.wallet !== wallet) continue;
        realizedPnlSol += h.realizedPnlSol;
        if (h.tokens <= TOKEN_EPSILON) continue;
        const coin = this.coinsById.get(h.coinId);
        if (!coin) continue;
        const summary = summaryOf(coin);
        const valueSol = round9(summary.priceSol * h.tokens);
        const pnl = round9(valueSol - h.costBasisSol);
        holdingsValueSol += valueSol;
        unrealizedPnlSol += pnl;
        holdings.push({ ...h, coin: summary, valueSol, unrealizedPnlSol: pnl });
      }
    }
    holdings.sort((a, b) => b.valueSol - a.valueSol);

    const trades: Portfolio["trades"] = [];
    if (wallet) {
      for (const t of this.state.trades.filter((t) => t.wallet === wallet).sort(newestFirst)) {
        const coin = this.coinsById.get(t.coinId);
        if (!coin) continue;
        trades.push({ ...t, coin: coinRef(coin) });
      }
    }

    const createdCoins = wallet
      ? this.state.coins
          .filter((c) => c.creatorWallet === wallet)
          .sort(newestFirst)
          .map((c) => summaryOf(c))
      : [];

    holdingsValueSol = round9(holdingsValueSol);
    return {
      wallet,
      balanceSol: 0,
      holdingsValueSol,
      totalValueSol: holdingsValueSol,
      realizedPnlSol: round9(realizedPnlSol),
      unrealizedPnlSol: round9(unrealizedPnlSol),
      creatorClaimableSol: 0,
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

  getCoinTrades(coinId: number, limit = RECENT_TRADES): (Trade & { user: PublicUser | null })[] {
    const trades = this.coinTrades(coinId);
    const out: (Trade & { user: PublicUser | null })[] = [];
    for (let i = trades.length - 1; i >= 0 && out.length < limit; i--) out.push(this.withUser(trades[i]));
    return out;
  }

  getStats(): PlatformStats {
    const traders = new Set<string>();
    let volumeSol = 0;
    let graduated = 0;
    for (const t of this.state.trades) {
      if (t.wallet) traders.add(t.wallet);
      volumeSol += t.sol;
    }
    for (const c of this.state.coins) if (c.curve.completed) graduated++;
    return {
      coins: this.state.coins.length,
      volumeSol: round9(volumeSol),
      traders: traders.size,
      trades: this.state.trades.length,
      graduated,
    };
  }

  /** Public profile page data, or undefined when no such user exists. */
  getPublicProfile(
    username: string,
  ): { user: PublicUser; coins: CoinSummary[]; trades: (Trade & { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> })[] } | undefined {
    const user = this.getUserByUsername(username);
    if (!user) return undefined;
    const now = Date.now();
    const wallet = user.walletAddress;
    const coins = this.state.coins
      .filter((c) => c.creatorId === user.id || (wallet !== null && c.creatorWallet === wallet))
      .sort(newestFirst)
      .map((c) => this.summarize(c, now));

    const trades: (Trade & { coin: Pick<Coin, "id" | "ca" | "name" | "ticker" | "imageUrl"> })[] = [];
    for (const t of this.state.trades.slice().sort(newestFirst)) {
      if (t.userId !== user.id && (!wallet || t.wallet !== wallet)) continue;
      const coin = this.coinsById.get(t.coinId);
      if (!coin) continue;
      trades.push({ ...t, coin: coinRef(coin) });
      if (trades.length >= 100) break;
    }
    const publicUser = this.toPublicUser(user.id);
    return publicUser ? { user: publicUser, coins, trades } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton & initialisation
// ---------------------------------------------------------------------------

export let storage: Storage;

/**
 * Creates the storage singleton, loads the persisted snapshot and wires up
 * debounced persistence. Demo data is only fabricated when SEED_DEMO=1 and no
 * real DBC config is set (see seed.ts).
 */
export async function initStorage(): Promise<Storage> {
  const instance = new Storage();
  storage = instance;

  const backend = createBackend();
  const raw = await backend.load();
  if (raw) {
    instance.restore(raw);
    const s = instance.snapshot();
    log(`loaded state from ${backend.name}: ${s.users.length} users, ${s.coins.length} coins, ${s.trades.length} trades`, "storage");
  } else {
    log(`no snapshot in ${backend.name}, starting empty`, "storage");
  }

  instance.bindPersister(new Persister(backend, () => instance.snapshot()));
  return instance;
}
