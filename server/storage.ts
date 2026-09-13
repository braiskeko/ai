/**
 * Foresight storage layer.
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
 *  - prices are LMSR probabilities that sum to 1 across a market's outcomes
 *  - entity objects are mutated in place; the arrays in `state` own them and
 *    the Maps below are pure lookup indexes over the very same objects
 */
import { randomUUID } from "crypto";
import {
  MARKET_CATEGORIES,
  NO_COLOR,
  OUTCOME_COLORS,
  YES_COLOR,
  type ActivityItem,
  type AdminUserRow,
  type AuthProvider,
  type Comment,
  type CommentView,
  type CreateMarketInput,
  type Deposit,
  type LeaderboardEntry,
  type Market,
  type MarketDetail,
  type MarketOutcome,
  type MarketStatus,
  type MarketSummary,
  type PlatformStats,
  type Portfolio,
  type PortfolioPosition,
  type Position,
  type PricePoint,
  type PublicUser,
  type SafeUser,
  type Trade,
  type TradeQuote,
  type User,
  type WalletView,
  type Withdrawal,
  type WithdrawalStatus,
} from "@shared/schema";
import * as lmsr from "./lmsr";
import { config } from "./config";
import { createBackend, Persister } from "./persistence";
import { seedMarkets, type SeedMarket } from "./seed";
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

export interface MarketFilters {
  category?: string;
  status?: "open" | "closed" | "resolved" | "all";
  search?: string;
  sort?: "volume" | "newest" | "ending" | "trending";
}

export interface StorageOptions {
  /** Derives the on-chain deposit address for a user's HD wallet index. */
  deriveDepositAddress: (index: number) => string;
}

/** Next id to hand out for each entity type. */
interface IdCounters {
  user: number;
  market: number;
  position: number;
  trade: number;
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
  markets: Market[];
  positions: Position[];
  trades: Trade[];
  /** market id (as string) -> chronological price points */
  priceHistory: Record<string, PricePoint[]>;
  comments: Comment[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  /** admin credits waiting for a user with that (lowercase) username to appear */
  pendingCredits: Record<string, number>;
  /** INITIAL_CREDITS entries ("user:amount") that were already applied */
  appliedCredits: string[];
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MIN_TRADE_USDC = 0.1;
const MIN_WITHDRAWAL_USDC = 1;
const FAUCET_COOLDOWN_MS = 10 * MINUTE_MS;
/** Positions holding fewer shares than this are treated as empty. */
const SHARE_EPSILON = 1e-6;
/** Tolerance for floating point comparisons of balances / share counts. */
const DUST = 1e-9;
/** Positions below this size are not shown as "holdings" in market views. */
const DISPLAY_MIN_SHARES = 0.01;

const BOT_NAMES = ["oracle_dan", "cassandra", "quant_maria", "delphi", "nostradamus_jr", "polly", "hedgehog", "sybil"];
/** Deterministic seed so a fresh deployment always produces the same demo data. */
const SEED_PRNG_SEED = 42;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const nowIso = (): string => new Date().toISOString();
const iso = (ms: number): string => new Date(ms).toISOString();
const ts = (isoString: string): number => Date.parse(isoString);

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

/** Picks an index with probability proportional to its weight, given a uniform sample `r` in [0, 1). */
function sampleIndex(weights: number[], r: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r * total < acc) return i;
  }
  return weights.length - 1;
}

/** Classic 32-bit linear congruential generator; returns uniform numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Newest first, ties broken by id so ordering is stable. */
function newestFirst<T extends { id: number; createdAt: string }>(a: T, b: T): number {
  return ts(b.createdAt) - ts(a.createdAt) || b.id - a.id;
}

/**
 * Builds outcome descriptors from names. Exactly ["Yes", "No"] (case-insensitive,
 * in that order) is a binary market and gets the canonical names and colours.
 */
function buildOutcomes(names: string[]): { binary: boolean; outcomes: MarketOutcome[] } {
  const binary = names.length === 2 && names[0].trim().toLowerCase() === "yes" && names[1].trim().toLowerCase() === "no";
  if (binary) {
    return {
      binary,
      outcomes: [
        { id: 0, name: "Yes", color: YES_COLOR },
        { id: 1, name: "No", color: NO_COLOR },
      ],
    };
  }
  return {
    binary,
    outcomes: names.map((name, id) => ({ id, name: name.trim(), color: OUTCOME_COLORS[id % OUTCOME_COLORS.length] })),
  };
}

/** Outcome-id-shaped price vector of a settled market: 1 for the winner, 0 elsewhere. */
function resolutionPrices(m: Market, winner: number): number[] {
  return m.outcomes.map((o) => (o.id === winner ? 1 : 0));
}

function emptyState(): State {
  return {
    version: 1,
    mnemonic: null,
    lastScannedBlock: null,
    ids: { user: 1, market: 1, position: 1, trade: 1, comment: 1, deposit: 1, withdrawal: 1 },
    users: [],
    markets: [],
    positions: [],
    trades: [],
    priceHistory: {},
    comments: [],
    deposits: [],
    withdrawals: [],
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
  markets?: Partial<Market>[];
  positions?: Partial<Position>[];
  trades?: Partial<Trade>[];
  priceHistory?: Record<string, PricePoint[]>;
  comments?: Partial<Comment>[];
  deposits?: Partial<Deposit>[];
  withdrawals?: Partial<Withdrawal>[];
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
        provider: "email",
        isAdmin: false,
        balance: 0,
        depositIndex: -1,
        depositAddress: "",
        createdAt: now,
      },
      u,
    ),
  );

  const markets = (loose.markets ?? []).map((m) => {
    const outcomes = m.outcomes && m.outcomes.length >= 2 ? m.outcomes : buildOutcomes(["Yes", "No"]).outcomes;
    const liquidity = m.liquidity ?? 1000;
    const createdAt = m.createdAt ?? now;
    const status = m.status ?? "open";
    return withDefaults<Market>(
      {
        id: 0,
        slug: "",
        question: "",
        description: "",
        rules: "",
        category: MARKET_CATEGORIES[0],
        imageEmoji: "🔮",
        creatorId: 0,
        status,
        binary: outcomes.length === 2 && outcomes[0].name === "Yes" && outcomes[1].name === "No",
        outcomes,
        resolution: null,
        rejectionReason: null,
        liquidity,
        q: lmsr.initialQuantities(
          liquidity,
          outcomes.map(() => 1 / outcomes.length),
        ),
        volume: 0,
        featured: false,
        endDate: createdAt,
        createdAt,
        publishedAt: status === "pending" || status === "rejected" ? null : createdAt,
        resolvedAt: null,
      },
      m,
    );
  });

  const positions = (loose.positions ?? []).map((p) =>
    withDefaults<Position>({ id: 0, userId: 0, marketId: 0, outcomeId: 0, shares: 0, costBasis: 0, realizedPnl: 0 }, p),
  );

  const trades = (loose.trades ?? []).map((t) =>
    withDefaults<Trade>(
      { id: 0, userId: 0, marketId: 0, outcomeId: 0, side: "buy", shares: 0, amount: 0, avgPrice: 0, pricesAfter: [], createdAt: now },
      t,
    ),
  );

  const comments = (loose.comments ?? []).map((c) =>
    withDefaults<Comment>({ id: 0, marketId: 0, userId: 0, parentId: null, body: "", likes: [], createdAt: now }, c),
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

  // Keep only well-formed history arrays and make sure every market has at least one point.
  const priceHistory: Record<string, PricePoint[]> = {};
  for (const [key, points] of Object.entries(loose.priceHistory ?? {})) {
    if (Array.isArray(points)) priceHistory[key] = points;
  }
  for (const m of markets) {
    const key = String(m.id);
    if (!priceHistory[key]?.length) {
      priceHistory[key] = [{ t: m.createdAt, p: lmsr.prices({ liquidity: m.liquidity, q: m.q }) }];
    }
  }

  return {
    version: 1,
    mnemonic: loose.mnemonic ?? null,
    lastScannedBlock: loose.lastScannedBlock ?? null,
    pendingCredits: loose.pendingCredits ?? {},
    appliedCredits: loose.appliedCredits ?? [],
    ids: {
      user: nextIdAfter(users, loose.ids?.user),
      market: nextIdAfter(markets, loose.ids?.market),
      position: nextIdAfter(positions, loose.ids?.position),
      trade: nextIdAfter(trades, loose.ids?.trade),
      comment: nextIdAfter(comments, loose.ids?.comment),
      deposit: nextIdAfter(deposits, loose.ids?.deposit),
      withdrawal: nextIdAfter(withdrawals, loose.ids?.withdrawal),
    },
    users,
    markets,
    positions,
    trades,
    priceHistory,
    comments,
    deposits,
    withdrawals,
  };
}

// ---------------------------------------------------------------------------
// Portfolio history replay
// ---------------------------------------------------------------------------

/** A cash-affecting event in a user's ledger, replayed chronologically to chart portfolio value. */
type LedgerEvent =
  | { kind: "deposit"; t: number; amount: number }
  | { kind: "withdrawal"; t: number; amount: number }
  | { kind: "trade"; t: number; trade: Trade }
  | { kind: "resolve"; t: number; marketId: number; outcomeId: number };

/** Tie-break order for events sharing a timestamp: cash in, cash out, trades, then settlement. */
const LEDGER_ORDER: Record<LedgerEvent["kind"], number> = { deposit: 0, withdrawal: 1, trade: 2, resolve: 3 };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class Storage {
  private state: State = emptyState();
  private persister: Persister | null = null;

  // Lookup indexes over the objects held in `state` (rebuilt on restore).
  private usersById = new Map<number, User>();
  private usersByEmail = new Map<string, User>();
  private marketsById = new Map<number, Market>();
  private marketsBySlug = new Map<string, Market>();
  private positionsByKey = new Map<string, Position>();
  private commentsById = new Map<number, Comment>();
  private withdrawalsById = new Map<number, Withdrawal>();
  private depositTxHashes = new Set<string>();

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
    this.marketsById.clear();
    this.marketsBySlug.clear();
    this.positionsByKey.clear();
    this.commentsById.clear();
    this.withdrawalsById.clear();
    this.depositTxHashes.clear();
    for (const u of this.state.users) this.indexUser(u);
    for (const m of this.state.markets) this.indexMarket(m);
    for (const p of this.state.positions) this.positionsByKey.set(positionKey(p.userId, p.marketId, p.outcomeId), p);
    for (const c of this.state.comments) this.commentsById.set(c.id, c);
    for (const w of this.state.withdrawals) this.withdrawalsById.set(w.id, w);
    for (const d of this.state.deposits) this.depositTxHashes.add(d.txHash.toLowerCase());
  }

  private indexUser(u: User): void {
    this.usersById.set(u.id, u);
    this.usersByEmail.set(u.email.toLowerCase(), u);
  }

  private indexMarket(m: Market): void {
    this.marketsById.set(m.id, m);
    this.marketsBySlug.set(m.slug, m);
  }

  private addUser(u: User): User {
    this.state.users.push(u);
    this.indexUser(u);
    return u;
  }

  private addMarket(m: Market): Market {
    this.state.markets.push(m);
    this.indexMarket(m);
    return m;
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

    // Bots use depositIndex -1; real users get consecutive HD wallet indexes.
    const realUsers = this.state.users.filter((u) => u.depositIndex >= 0);
    const depositIndex = realUsers.reduce((mx, u) => Math.max(mx, u.depositIndex), -1) + 1;
    const depositAddress = this.opts.deriveDepositAddress(depositIndex);
    const bootstrapAdmin = config.adminEmails.length === 0 && realUsers.length === 0;

    const user = this.addUser({
      id: this.nextId("user"),
      email: normalized,
      username: this.uniqueUsername(displayName?.trim() || normalized.split("@")[0]),
      avatarSeed: randomUUID(),
      provider,
      isAdmin: listedAdmin || bootstrapAdmin,
      balance: 0,
      depositIndex,
      depositAddress,
      createdAt: nowIso(),
    });
    if (bootstrapAdmin) log(`${normalized} is the first account on this deployment and was granted admin`, "storage");
    this.applyPendingCredit(user);
    this.persist();
    return { user, created: true };
  }

  /** Case-insensitive username lookup. */
  getUserByUsername(username: string): User | undefined {
    const lower = username.trim().replace(/^@/, "").toLowerCase();
    return this.state.users.find((u) => u.username.toLowerCase() === lower);
  }

  /** Admin listing for the users tab (bots excluded); newest first, optional substring filter. */
  listUsers(search = "", limit = 50): AdminUserRow[] {
    const needle = search.trim().replace(/^@/, "").toLowerCase();
    return this.state.users
      .filter((u) => u.depositIndex >= 0)
      .filter((u) => !needle || u.username.toLowerCase().includes(needle) || u.email.includes(needle))
      .sort(newestFirst)
      .slice(0, limit)
      .map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        balance: u.balance,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
        positions: this.state.positions.filter((p) => p.userId === u.id && p.shares > SHARE_EPSILON).length,
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
    if (base.length < 3) base = "trader";
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

  /** Strips fields that must never leave the server. */
  toSafeUser(u: User): SafeUser {
    const { depositIndex: _depositIndex, ...safe } = u;
    return safe;
  }

  toPublicUser(id: number): PublicUser {
    const u = this.usersById.get(id);
    return u ? { id: u.id, username: u.username, avatarSeed: u.avatarSeed } : { id, username: "unknown", avatarSeed: "unknown" };
  }

  // -------------------------------------------------------------------------
  // Markets: helpers
  // -------------------------------------------------------------------------

  private mustMarket(id: number): Market {
    const m = this.marketsById.get(id);
    if (!m) throw new HttpError(404, "Market not found");
    return m;
  }

  private assertOutcome(m: Market, outcomeId: number): void {
    if (!Number.isInteger(outcomeId) || outcomeId < 0 || outcomeId >= m.outcomes.length) {
      throw new HttpError(400, "Invalid outcome");
    }
  }

  private lmsrState(m: Market): lmsr.LmsrState {
    return { liquidity: m.liquidity, q: m.q };
  }

  /** Price history array for a market, created on first access. */
  private history(marketId: number): PricePoint[] {
    return (this.state.priceHistory[String(marketId)] ??= []);
  }

  /** "open" markets whose end date has passed are "closed" (awaiting resolution). */
  private effectiveStatus(m: Market): MarketStatus {
    return m.status === "open" && ts(m.endDate) <= Date.now() ? "closed" : m.status;
  }

  private isHidden(m: Market): boolean {
    return m.status === "pending" || m.status === "rejected";
  }

  /** Current outcome prices: LMSR probabilities, or the 1/0 payout vector once resolved. */
  private currentPrices(m: Market): number[] {
    if (m.status === "resolved" && m.resolution !== null) return resolutionPrices(m, m.resolution);
    return lmsr.prices(this.lmsrState(m));
  }

  private positionPrice(m: Market, outcomeId: number): number {
    return this.currentPrices(m)[outcomeId];
  }

  /**
   * Movement of the leading outcome (Yes for binary markets) versus the latest
   * price point at or before 24h ago, or the first point for younger markets.
   */
  private change24h(m: Market, prices: number[]): number {
    const points = this.history(m.id);
    if (!points.length) return 0;
    const lead = m.binary ? 0 : argmax(prices);
    const cutoff = Date.now() - DAY_MS;
    let reference = points[0];
    for (const pt of points) {
      const t = ts(pt.t);
      if (t <= cutoff && t >= ts(reference.t)) reference = pt;
    }
    return prices[lead] - (reference.p[lead] ?? prices[lead]);
  }

  private summarize(m: Market): MarketSummary {
    const prices = this.currentPrices(m);
    const traders = new Set<number>();
    for (const t of this.state.trades) if (t.marketId === m.id) traders.add(t.userId);
    let commentCount = 0;
    for (const c of this.state.comments) if (c.marketId === m.id) commentCount++;
    return {
      ...m,
      status: this.effectiveStatus(m),
      prices,
      traders: traders.size,
      change24h: this.change24h(m, prices),
      creator: this.toPublicUser(m.creatorId),
      commentCount,
    };
  }

  private uniqueSlug(question: string, id: number): string {
    const base = slugify(question) || "market";
    if (!this.marketsBySlug.has(base)) return base;
    let candidate = `${base.slice(0, 80 - String(id).length - 1)}-${id}`;
    for (let n = 2; this.marketsBySlug.has(candidate); n++) candidate = `${base.slice(0, 60)}-${id}-${n}`;
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Markets: queries
  // -------------------------------------------------------------------------

  listMarkets(filters: MarketFilters): MarketSummary[] {
    const status = filters.status ?? "open";
    const category = filters.category?.trim().toLowerCase();
    const search = filters.search?.trim().toLowerCase();

    const list: MarketSummary[] = [];
    for (const m of this.state.markets) {
      if (this.isHidden(m)) continue;
      if (category && category !== "all" && m.category.toLowerCase() !== category) continue;
      if (search && !matchesSearch(m, search)) continue;
      const summary = this.summarize(m);
      if (status !== "all" && summary.status !== status) continue;
      list.push(summary);
    }

    switch (filters.sort ?? "volume") {
      case "newest":
        list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
        break;
      case "ending":
        list.sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || ts(a.endDate) - ts(b.endDate));
        break;
      case "trending":
        list.sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h) || b.volume - a.volume);
        break;
      case "volume":
        list.sort((a, b) => Number(b.featured) - Number(a.featured) || b.volume - a.volume);
        break;
    }
    return list;
  }

  /** Every market a user created, in any status, newest first. */
  listMyMarkets(userId: number): MarketSummary[] {
    return this.state.markets
      .filter((m) => m.creatorId === userId)
      .sort(newestFirst)
      .map((m) => this.summarize(m));
  }

  /** Admin view: markets by effective status, newest first. */
  listMarketsByStatus(status: MarketStatus): MarketSummary[] {
    return this.state.markets
      .filter((m) => this.effectiveStatus(m) === status)
      .sort(newestFirst)
      .map((m) => this.summarize(m));
  }

  /** Full market page. Pending/rejected markets are only visible to their creator and admins. */
  getMarketBySlug(slug: string, viewer?: User): MarketDetail | undefined {
    const m = this.marketsBySlug.get(slug);
    if (!m) return undefined;
    if (this.isHidden(m) && !(viewer && (viewer.id === m.creatorId || viewer.isAdmin))) return undefined;

    const recentTrades = this.state.trades
      .filter((t) => t.marketId === m.id)
      .sort(newestFirst)
      .slice(0, 50)
      .map((t) => ({ ...t, user: this.toPublicUser(t.userId) }));

    const comments = this.state.comments
      .filter((c) => c.marketId === m.id)
      .sort(newestFirst)
      .map((c) => this.toCommentView(c));

    const holders = this.state.positions
      .filter((p) => p.marketId === m.id && p.shares > DISPLAY_MIN_SHARES)
      .sort((a, b) => b.shares - a.shares)
      .slice(0, 20)
      .map((p) => ({ user: this.toPublicUser(p.userId), outcomeId: p.outcomeId, shares: p.shares }));

    const myPositions = viewer
      ? this.state.positions.filter((p) => p.marketId === m.id && p.userId === viewer.id && p.shares > 0)
      : [];

    return { ...this.summarize(m), priceHistory: this.history(m.id).slice(), recentTrades, comments, holders, myPositions };
  }

  // -------------------------------------------------------------------------
  // Markets: mutations
  // -------------------------------------------------------------------------

  /** Admins publish immediately; everyone else's market waits for review as "pending". */
  createMarket(creator: User, input: CreateMarketInput): MarketSummary {
    const { binary, outcomes } = buildOutcomes(input.outcomes);
    const probabilities = input.initialProbabilities ?? outcomes.map(() => 1 / outcomes.length);
    const now = nowIso();
    const open = creator.isAdmin;
    const id = this.nextId("market");

    const market = this.addMarket({
      id,
      slug: this.uniqueSlug(input.question, id),
      question: input.question,
      description: input.description,
      rules: input.rules,
      category: input.category,
      imageEmoji: input.imageEmoji,
      creatorId: creator.id,
      status: open ? "open" : "pending",
      binary,
      outcomes,
      resolution: null,
      rejectionReason: null,
      liquidity: input.liquidity,
      q: lmsr.initialQuantities(input.liquidity, probabilities),
      volume: 0,
      featured: false,
      endDate: new Date(input.endDate).toISOString(),
      createdAt: now,
      publishedAt: open ? now : null,
      resolvedAt: null,
    });
    this.history(id).push({ t: now, p: lmsr.prices(this.lmsrState(market)) });
    this.persist();
    return this.summarize(market);
  }

  reviewMarket(id: number, action: "approve" | "reject", reason?: string, featured?: boolean): MarketSummary {
    const m = this.mustMarket(id);
    if (m.status !== "pending") throw new HttpError(400, "Only pending markets can be reviewed");
    if (action === "approve") {
      m.status = "open";
      m.publishedAt = nowIso();
      m.featured = !!featured;
      m.rejectionReason = null;
    } else {
      m.status = "rejected";
      m.rejectionReason = reason?.trim() || "Rejected by moderators";
    }
    this.persist();
    return this.summarize(m);
  }

  /** Settles a market: winners are paid 1 USDC per share, every position in the market is closed. */
  resolveMarket(id: number, outcomeId: number): MarketSummary {
    const m = this.mustMarket(id);
    const status = this.effectiveStatus(m);
    if (status !== "open" && status !== "closed") throw new HttpError(400, `A ${status} market cannot be resolved`);
    this.assertOutcome(m, outcomeId);
    this.applyResolution(m, outcomeId, nowIso());
    this.persist();
    return this.summarize(m);
  }

  private applyResolution(m: Market, outcomeId: number, at: string): void {
    for (const p of this.state.positions) {
      if (p.marketId !== m.id) continue;
      const payout = p.outcomeId === outcomeId ? p.shares : 0;
      const holder = this.usersById.get(p.userId);
      if (holder && payout > 0) holder.balance = round6(holder.balance + payout);
      p.realizedPnl = round6(p.realizedPnl + payout - p.costBasis);
      p.shares = 0;
      p.costBasis = 0;
    }
    m.status = "resolved";
    m.resolution = outcomeId;
    m.resolvedAt = at;
    if (ts(m.endDate) > ts(at)) m.endDate = at;
    this.history(m.id).push({ t: at, p: resolutionPrices(m, outcomeId) });
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  private findPosition(userId: number, marketId: number, outcomeId: number): Position | undefined {
    return this.positionsByKey.get(positionKey(userId, marketId, outcomeId));
  }

  private getOrCreatePosition(userId: number, marketId: number, outcomeId: number): Position {
    const existing = this.findPosition(userId, marketId, outcomeId);
    if (existing) return existing;
    const created: Position = { id: this.nextId("position"), userId, marketId, outcomeId, shares: 0, costBasis: 0, realizedPnl: 0 };
    this.state.positions.push(created);
    this.positionsByKey.set(positionKey(userId, marketId, outcomeId), created);
    return created;
  }

  /** The user's largest holding in a market (for comment badges), or null if none is meaningful. */
  private largestPosition(userId: number, marketId: number): { outcomeId: number; shares: number } | null {
    let best: Position | null = null;
    for (const p of this.state.positions) {
      if (p.userId !== userId || p.marketId !== marketId || p.shares <= DISPLAY_MIN_SHARES) continue;
      if (!best || p.shares > best.shares) best = p;
    }
    return best ? { outcomeId: best.outcomeId, shares: best.shares } : null;
  }

  /** Validates an order and prices it against the current LMSR state. */
  private prepareQuote(m: Market, user: User, outcomeId: number, side: "buy" | "sell", amount: number): lmsr.Quote {
    if (this.effectiveStatus(m) !== "open") throw new HttpError(400, "This market is not open for trading");
    this.assertOutcome(m, outcomeId);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Amount must be a positive number");

    const state = this.lmsrState(m);
    let quote: lmsr.Quote;
    if (side === "buy") {
      const usdc = round6(amount);
      if (usdc < MIN_TRADE_USDC) throw new HttpError(400, `Minimum trade is ${MIN_TRADE_USDC} USDC`);
      if (usdc > user.balance + DUST) throw new HttpError(400, "Insufficient balance");
      quote = lmsr.quoteBuy(state, outcomeId, usdc);
    } else {
      const owned = this.findPosition(user.id, m.id, outcomeId)?.shares ?? 0;
      if (amount > owned + DUST) throw new HttpError(400, "You don't own that many shares");
      quote = lmsr.quoteSell(state, outcomeId, Math.min(amount, owned));
    }
    if (quote.shares <= DUST) throw new HttpError(400, "Trade too small");
    return quote;
  }

  quote(marketId: number, userId: number, outcomeId: number, side: "buy" | "sell", amount: number): TradeQuote {
    const q = this.prepareQuote(this.mustMarket(marketId), this.mustUser(userId), outcomeId, side, amount);
    return {
      outcomeId: q.outcomeId,
      side: q.side,
      shares: q.shares,
      amount: round6(q.amount),
      avgPrice: q.avgPrice,
      priceBefore: q.priceBefore,
      priceAfter: q.priceAfter,
      maxPayout: q.maxPayout,
    };
  }

  /** Executes an order. `amount` is USDC to spend for buys and shares to sell for sells. */
  trade(
    marketId: number,
    userId: number,
    outcomeId: number,
    side: "buy" | "sell",
    amount: number,
  ): { trade: Trade; market: MarketSummary; user: User } {
    const m = this.mustMarket(marketId);
    const user = this.mustUser(userId);
    const q = this.prepareQuote(m, user, outcomeId, side, amount);
    const trade = this.settle(m, user, q, nowIso());
    this.persist();
    return { trade, market: this.summarize(m), user };
  }

  /**
   * Applies a priced order to the ledger: user balance, position (average-cost
   * accounting), market quantities and volume, price history and trade log.
   * Shared by live trading and the seed simulation.
   */
  private settle(m: Market, user: User, q: lmsr.Quote, at: string): Trade {
    const pos = this.getOrCreatePosition(user.id, m.id, q.outcomeId);
    if (q.side === "buy") {
      user.balance = round6(user.balance - q.amount);
      pos.shares += q.shares;
      pos.costBasis = round6(pos.costBasis + q.amount);
    } else {
      const fraction = pos.shares > 0 ? Math.min(1, q.shares / pos.shares) : 1;
      const costOfSold = pos.costBasis * fraction;
      user.balance = round6(user.balance + q.amount);
      pos.realizedPnl = round6(pos.realizedPnl + q.amount - costOfSold);
      pos.costBasis = round6(pos.costBasis - costOfSold);
      pos.shares -= q.shares;
      if (pos.shares < SHARE_EPSILON) {
        pos.shares = 0;
        pos.costBasis = 0;
      }
    }

    m.q = q.nextState.q;
    m.volume = round6(m.volume + q.amount);
    this.history(m.id).push({ t: at, p: q.pricesAfter });

    const trade: Trade = {
      id: this.nextId("trade"),
      userId: user.id,
      marketId: m.id,
      outcomeId: q.outcomeId,
      side: q.side,
      shares: q.shares,
      amount: round6(q.amount),
      avgPrice: q.avgPrice,
      pricesAfter: q.pricesAfter,
      createdAt: at,
    };
    this.state.trades.push(trade);
    return trade;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private toCommentView(c: Comment): CommentView {
    return { ...c, user: this.toPublicUser(c.userId), position: this.largestPosition(c.userId, c.marketId) };
  }

  addComment(marketId: number, userId: number, body: string, parentId?: number | null): CommentView {
    const m = this.mustMarket(marketId);
    this.mustUser(userId);
    if (parentId !== undefined && parentId !== null) {
      const parent = this.commentsById.get(parentId);
      if (!parent || parent.marketId !== m.id) throw new HttpError(400, "Parent comment not found in this market");
    }
    const comment: Comment = {
      id: this.nextId("comment"),
      marketId: m.id,
      userId,
      parentId: parentId ?? null,
      body,
      likes: [],
      createdAt: nowIso(),
    };
    this.state.comments.push(comment);
    this.commentsById.set(comment.id, comment);
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
    const summaries = new Map<number, MarketSummary>();
    const summaryOf = (m: Market): MarketSummary => {
      let s = summaries.get(m.id);
      if (!s) {
        s = this.summarize(m);
        summaries.set(m.id, s);
      }
      return s;
    };

    let positionsValue = 0;
    let unrealizedPnl = 0;
    let realizedPnl = 0;
    const positions: PortfolioPosition[] = [];
    for (const p of this.state.positions) {
      if (p.userId !== userId) continue;
      realizedPnl += p.realizedPnl;
      if (p.shares <= SHARE_EPSILON) continue;
      const m = this.marketsById.get(p.marketId);
      if (!m) continue;
      const currentPrice = this.positionPrice(m, p.outcomeId);
      const currentValue = round6(currentPrice * p.shares);
      const pnl = round6(currentValue - p.costBasis);
      positionsValue += currentValue;
      unrealizedPnl += pnl;
      positions.push({ ...p, market: summaryOf(m), currentPrice, currentValue, unrealizedPnl: pnl });
    }
    positions.sort((a, b) => b.currentValue - a.currentValue);

    let volume = 0;
    const trades: Portfolio["trades"] = [];
    for (const t of this.state.trades.filter((t) => t.userId === userId).sort(newestFirst)) {
      volume += t.amount;
      const m = this.marketsById.get(t.marketId);
      if (!m) continue;
      trades.push({ ...t, market: { id: m.id, slug: m.slug, question: m.question, imageEmoji: m.imageEmoji, outcomes: m.outcomes } });
    }

    positionsValue = round6(positionsValue);
    return {
      balance: user.balance,
      positionsValue,
      totalValue: round6(user.balance + positionsValue),
      unrealizedPnl: round6(unrealizedPnl),
      realizedPnl: round6(realizedPnl),
      volume: round6(volume),
      positions,
      trades,
      history: this.buildHistory(user, positionsValue),
    };
  }

  /**
   * Approximate portfolio value over time, rebuilt from the user's ledger:
   * deposits add cash, withdrawals remove it, buys move cash into positions at
   * cost (value unchanged), sells and resolutions realise profit or loss. Cash
   * the ledger cannot explain (faucet credits, seed balances) is attributed to
   * the starting point, and a final "now" point marks open positions to market.
   */
  private buildHistory(user: User, positionsValue: number): { t: string; v: number }[] {
    const events: LedgerEvent[] = [];
    for (const d of this.state.deposits) if (d.userId === user.id) events.push({ kind: "deposit", t: ts(d.createdAt), amount: d.amount });
    for (const w of this.state.withdrawals) {
      if (w.userId === user.id && w.status !== "failed") events.push({ kind: "withdrawal", t: ts(w.createdAt), amount: w.amount });
    }
    const tradedMarkets = new Set<number>();
    for (const t of this.state.trades) {
      if (t.userId !== user.id) continue;
      events.push({ kind: "trade", t: ts(t.createdAt), trade: t });
      tradedMarkets.add(t.marketId);
    }
    for (const marketId of Array.from(tradedMarkets)) {
      const m = this.marketsById.get(marketId);
      if (m && m.status === "resolved" && m.resolution !== null && m.resolvedAt) {
        events.push({ kind: "resolve", t: ts(m.resolvedAt), marketId, outcomeId: m.resolution });
      }
    }
    events.sort((a, b) => a.t - b.t || LEDGER_ORDER[a.kind] - LEDGER_ORDER[b.kind]);

    // Replay from zero, tracking open lots at cost and the net cash the events explain.
    const lots = new Map<string, { shares: number; basis: number }>();
    const lotKeys: string[] = [];
    const lotOf = (marketId: number, outcomeId: number) => {
      const key = `${marketId}:${outcomeId}`;
      let lot = lots.get(key);
      if (!lot) {
        lot = { shares: 0, basis: 0 };
        lots.set(key, lot);
        lotKeys.push(key);
      }
      return lot;
    };
    let value = 0;
    let cashDelta = 0;
    const replay: { t: number; v: number }[] = [];
    for (const e of events) {
      switch (e.kind) {
        case "deposit":
          value += e.amount;
          cashDelta += e.amount;
          break;
        case "withdrawal":
          value -= e.amount;
          cashDelta -= e.amount;
          break;
        case "trade": {
          const lot = lotOf(e.trade.marketId, e.trade.outcomeId);
          if (e.trade.side === "buy") {
            lot.shares += e.trade.shares;
            lot.basis += e.trade.amount;
            cashDelta -= e.trade.amount;
          } else {
            const fraction = lot.shares > 0 ? Math.min(1, e.trade.shares / lot.shares) : 1;
            const removed = lot.basis * fraction;
            lot.shares -= e.trade.shares;
            lot.basis -= removed;
            if (lot.shares < SHARE_EPSILON) {
              lot.shares = 0;
              lot.basis = 0;
            }
            value += e.trade.amount - removed;
            cashDelta += e.trade.amount;
          }
          break;
        }
        case "resolve":
          for (const key of lotKeys) {
            if (!key.startsWith(`${e.marketId}:`)) continue;
            const lot = lots.get(key);
            if (!lot || lot.shares <= 0) continue;
            const payout = key === `${e.marketId}:${e.outcomeId}` ? lot.shares : 0;
            value += payout - lot.basis;
            cashDelta += payout;
            lot.shares = 0;
            lot.basis = 0;
          }
          break;
      }
      replay.push({ t: e.t, v: value });
    }

    const startingValue = Math.max(0, round6(user.balance - cashDelta));
    const startAt = Math.min(ts(user.createdAt), replay.length ? replay[0].t : Infinity);
    const history = [{ t: iso(startAt), v: startingValue }];
    for (const pt of replay) history.push({ t: iso(pt.t), v: round6(pt.v + startingValue) });
    history.push({ t: nowIso(), v: round6(user.balance + positionsValue) });
    return history;
  }

  /** Everyone who has traded, ranked by realised + unrealised profit. */
  getLeaderboard(): LeaderboardEntry[] {
    const activity = new Map<number, { volume: number; markets: Set<number> }>();
    for (const t of this.state.trades) {
      let a = activity.get(t.userId);
      if (!a) {
        a = { volume: 0, markets: new Set<number>() };
        activity.set(t.userId, a);
      }
      a.volume += t.amount;
      a.markets.add(t.marketId);
    }

    const pnlByUser = new Map<number, number>();
    for (const p of this.state.positions) {
      let pnl = p.realizedPnl;
      if (p.shares > SHARE_EPSILON) {
        const m = this.marketsById.get(p.marketId);
        if (m) pnl += this.positionPrice(m, p.outcomeId) * p.shares - p.costBasis;
      }
      pnlByUser.set(p.userId, (pnlByUser.get(p.userId) ?? 0) + pnl);
    }

    const entries: LeaderboardEntry[] = [];
    for (const u of this.state.users) {
      const a = activity.get(u.id);
      if (!a) continue;
      entries.push({
        rank: 0,
        user: this.toPublicUser(u.id),
        pnl: round6(pnlByUser.get(u.id) ?? 0),
        volume: round6(a.volume),
        markets: a.markets.size,
      });
    }
    entries.sort((a, b) => b.pnl - a.pnl || b.volume - a.volume);
    return entries.slice(0, 100).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  /** Latest trades across all visible markets. */
  getActivity(limit: number): ActivityItem[] {
    const items: ActivityItem[] = [];
    for (const t of this.state.trades.slice().sort(newestFirst)) {
      const m = this.marketsById.get(t.marketId);
      if (!m || this.isHidden(m)) continue;
      items.push({
        trade: t,
        user: this.toPublicUser(t.userId),
        market: { id: m.id, slug: m.slug, question: m.question, imageEmoji: m.imageEmoji, outcomes: m.outcomes, binary: m.binary },
      });
      if (items.length >= limit) break;
    }
    return items;
  }

  getStats(): PlatformStats {
    const traders = new Set<number>();
    let volume = 0;
    for (const t of this.state.trades) {
      traders.add(t.userId);
      volume += t.amount;
    }
    return {
      volume: round6(volume),
      traders: traders.size,
      openMarkets: this.state.markets.filter((m) => this.effectiveStatus(m) === "open").length,
      trades: this.state.trades.length,
    };
  }

  // -------------------------------------------------------------------------
  // Seed data (fresh deployments only)
  // -------------------------------------------------------------------------

  /**
   * Populates an empty state with bot traders and the demo markets from seed.ts,
   * including a simulated trading history so charts and leaderboards look alive.
   * Fully deterministic given the same clock, thanks to the seeded PRNG.
   */
  seed(): void {
    const now = Date.now();
    const rand = lcg(SEED_PRNG_SEED);
    const oldestMarketDays = Math.max(0, ...seedMarkets.map((s) => s.ageDays)) + 7;

    const bots = BOT_NAMES.map((name) =>
      this.addUser({
        id: this.nextId("user"),
        email: `${name}@bots.foresight.local`,
        username: name,
        avatarSeed: name,
        provider: "email",
        isAdmin: false,
        balance: 5000,
        depositIndex: -1,
        depositAddress: "",
        createdAt: iso(now - oldestMarketDays * DAY_MS),
      }),
    );

    seedMarkets.forEach((s, i) => this.seedMarket(s, bots, bots[i % bots.length], rand, now));
    log(`seeded ${this.state.markets.length} markets, ${this.state.trades.length} trades`, "storage");
    this.persist();
  }

  private seedMarket(s: SeedMarket, bots: User[], creator: User, rand: () => number, now: number): void {
    const { binary, outcomes } = buildOutcomes(s.outcomes ?? ["Yes", "No"]);
    const createdMs = now - s.ageDays * DAY_MS;
    const endMs = now + s.daysLeft * DAY_MS;
    const createdAt = iso(createdMs);
    const id = this.nextId("market");
    const pickBot = (): User => bots[Math.floor(rand() * bots.length)];

    const market = this.addMarket({
      id,
      slug: this.uniqueSlug(s.question, id),
      question: s.question,
      description: s.description,
      rules: s.rules,
      category: s.category,
      imageEmoji: s.emoji,
      creatorId: creator.id,
      status: "open",
      binary,
      outcomes,
      resolution: null,
      rejectionReason: null,
      liquidity: s.liquidity,
      q: lmsr.initialQuantities(s.liquidity, s.startProbabilities),
      volume: 0,
      featured: !!s.featured,
      endDate: iso(endMs),
      createdAt,
      publishedAt: createdAt,
      resolvedAt: null,
    });
    this.history(id).push({ t: createdAt, p: lmsr.prices(this.lmsrState(market)) });

    // Trading activity spans the market's life but never continues past its end date.
    const lastTradeMs = s.daysLeft > 0 ? now : endMs;
    const span = lastTradeMs - createdMs;
    const steps = 40 + Math.floor(rand() * 41);
    for (let k = 0; k < steps; k++) {
      const progress = (k + 1) / steps;
      const prices = lmsr.prices(this.lmsrState(market));
      // Favour outcomes that are below where the story says they should be by now.
      const weights = prices.map((p, j) => {
        const target = s.startProbabilities[j] + (s.currentProbabilities[j] - s.startProbabilities[j]) * progress;
        return Math.max(0.02, target - p + 0.05);
      });
      const outcomeId = sampleIndex(weights, rand());
      const amount = round6(5 + rand() * 75);
      const at = iso(createdMs + (span * (k + 1)) / (steps + 1) + rand() * MINUTE_MS);
      this.applySeedTrade(market, pickBot(), outcomeId, amount, at);
    }

    // Land exactly on the story's current probabilities. LMSR prices depend only
    // on differences between quantities, so shift the target so every delta is a buy.
    const targetQ = lmsr.initialQuantities(market.liquidity, s.currentProbabilities);
    const shift = Math.max(...market.q.map((q, j) => q - targetQ[j]));
    const deltas = targetQ.map((tq, j) => tq + shift - market.q[j]);
    const calibrationAt = iso(lastTradeMs - MINUTE_MS);
    const hist = this.history(id);
    const pointsBefore = hist.length;
    deltas.forEach((delta, j) => {
      if (delta > DUST) this.applySeedShares(market, pickBot(), j, delta, calibrationAt);
    });
    // The calibration buys land one outcome at a time; keep only the final price point
    // so the chart does not show an artificial spike right before "now".
    const added = hist.length - pointsBefore;
    if (added > 1) hist.splice(pointsBefore, added - 1);

    for (const body of s.comments ?? []) {
      const comment: Comment = {
        id: this.nextId("comment"),
        marketId: id,
        userId: pickBot().id,
        parentId: null,
        body,
        likes: [],
        createdAt: iso(createdMs + rand() * span),
      };
      this.state.comments.push(comment);
      this.commentsById.set(comment.id, comment);
    }

    // Markets whose end date has already passed are settled on the most likely outcome.
    if (s.daysLeft <= 0) this.applyResolution(market, argmax(s.currentProbabilities), iso(endMs));
  }

  /** Seed-only buy of `amount` USDC. Mirrors trade() without validation; bots never run dry. */
  private applySeedTrade(market: Market, bot: User, outcomeId: number, amount: number, at: string): void {
    const q = lmsr.quoteBuy(this.lmsrState(market), outcomeId, amount);
    if (q.shares <= DUST) return;
    this.settle(market, bot, q, at);
    bot.balance = Math.max(100, bot.balance);
  }

  /** Seed-only buy of an exact number of shares (used to calibrate final prices). */
  private applySeedShares(market: Market, bot: User, outcomeId: number, shares: number, at: string): void {
    const state = this.lmsrState(market);
    const cost = lmsr.costOfShares(state, outcomeId, shares);
    const nextQ = state.q.slice();
    nextQ[outcomeId] += shares;
    const nextState: lmsr.LmsrState = { liquidity: state.liquidity, q: nextQ };
    const pricesAfter = lmsr.prices(nextState);
    this.settle(
      market,
      bot,
      {
        outcomeId,
        side: "buy",
        shares,
        amount: cost,
        avgPrice: cost / shares,
        priceBefore: lmsr.price(state, outcomeId),
        priceAfter: pricesAfter[outcomeId],
        maxPayout: shares,
        nextState,
        pricesAfter,
      },
      at,
    );
    bot.balance = Math.max(100, bot.balance);
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers that need no instance state
// ---------------------------------------------------------------------------

function positionKey(userId: number, marketId: number, outcomeId: number): string {
  return `${userId}:${marketId}:${outcomeId}`;
}

function matchesSearch(m: Market, needle: string): boolean {
  return (
    m.question.toLowerCase().includes(needle) ||
    m.description.toLowerCase().includes(needle) ||
    m.outcomes.some((o) => o.name.toLowerCase().includes(needle))
  );
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
    log(`loaded state from ${backend.name}: ${s.users.length} users, ${s.markets.length} markets, ${s.trades.length} trades`, "storage");
  } else {
    log(`no snapshot in ${backend.name}, seeding demo data`, "storage");
    instance.seed();
  }

  instance.bindPersister(new Persister(backend, () => instance.snapshot()));
  if (config.initialCredits) instance.applyInitialCredits(config.initialCredits);
  return instance;
}
