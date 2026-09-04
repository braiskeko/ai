import type {
  User,
  InsertUser,
  Market,
  Position,
  Trade,
  PricePoint,
  Comment,
  Outcome,
  CreateMarketInput,
  MarketSummary,
  MarketDetail,
  Portfolio,
  PortfolioPosition,
  LeaderboardEntry,
  PublicUser,
  ActivityItem,
  TradeQuote,
} from "@shared/schema";
import * as lmsr from "./lmsr";
import { seedMarkets } from "./seed";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface MarketFilters {
  category?: string;
  status?: string;
  search?: string;
  sort?: "volume" | "newest" | "ending" | "trending";
}

export interface IStorage {
  // users
  getUserBySessionId(sessionId: string): Promise<User | undefined>;
  getUser(id: number): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUsername(userId: number, username: string): Promise<User>;

  // markets
  listMarkets(filters: MarketFilters, viewerId?: number): Promise<MarketSummary[]>;
  getMarketBySlug(slug: string, viewerId?: number): Promise<MarketDetail | undefined>;
  createMarket(creatorId: number, input: CreateMarketInput): Promise<MarketSummary>;
  resolveMarket(marketId: number, userId: number, outcome: Outcome): Promise<MarketSummary>;

  // trading
  quote(marketId: number, userId: number, outcome: Outcome, side: "buy" | "sell", amount: number): Promise<TradeQuote>;
  trade(marketId: number, userId: number, outcome: Outcome, side: "buy" | "sell", amount: number): Promise<{ trade: Trade; market: MarketSummary; user: User }>;

  // social
  addComment(marketId: number, userId: number, body: string): Promise<Comment & { user: PublicUser }>;

  // aggregates
  getPortfolio(userId: number): Promise<Portfolio>;
  getLeaderboard(): Promise<LeaderboardEntry[]>;
  getActivity(limit: number): Promise<ActivityItem[]>;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);

const ADJECTIVES = ["swift", "bold", "quiet", "lucky", "clever", "brave", "calm", "sharp", "witty", "keen"];
const NOUNS = ["otter", "falcon", "badger", "lynx", "heron", "fox", "panda", "raven", "tiger", "wolf"];

function randomUsername(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}_${n}_${Math.floor(Math.random() * 900 + 100)}`;
}

export class MemStorage implements IStorage {
  private users = new Map<number, User>();
  private markets = new Map<number, Market>();
  private positions = new Map<number, Position>();
  private trades = new Map<number, Trade>();
  private pricePoints = new Map<number, PricePoint>();
  private comments = new Map<number, Comment>();
  private ids = { user: 1, market: 1, position: 1, trade: 1, price: 1, comment: 1 };

  constructor() {
    this.seed();
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async getUserBySessionId(sessionId: string): Promise<User | undefined> {
    for (const u of this.users.values()) if (u.sessionId === sessionId) return u;
    return undefined;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async createUser(insert: InsertUser): Promise<User> {
    const id = this.ids.user++;
    const user: User = {
      id,
      sessionId: insert.sessionId,
      username: insert.username,
      avatarSeed: insert.avatarSeed,
      balance: 1000,
      createdAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  async updateUsername(userId: number, username: string): Promise<User> {
    const user = this.mustUser(userId);
    for (const u of this.users.values()) {
      if (u.id !== userId && u.username.toLowerCase() === username.toLowerCase()) {
        throw new HttpError(409, "That username is already taken");
      }
    }
    const updated = { ...user, username };
    this.users.set(userId, updated);
    return updated;
  }

  private mustUser(id: number): User {
    const u = this.users.get(id);
    if (!u) throw new HttpError(404, "User not found");
    return u;
  }

  private publicUser(id: number): PublicUser {
    const u = this.users.get(id);
    return u
      ? { id: u.id, username: u.username, avatarSeed: u.avatarSeed }
      : { id, username: "unknown", avatarSeed: "unknown" };
  }

  // -------------------------------------------------------------------------
  // Markets
  // -------------------------------------------------------------------------

  private mustMarket(id: number): Market {
    const m = this.markets.get(id);
    if (!m) throw new HttpError(404, "Market not found");
    return m;
  }

  private marketState(m: Market): lmsr.LmsrState {
    return { liquidity: m.liquidity, qYes: m.qYes, qNo: m.qNo };
  }

  private effectiveStatus(m: Market): Market["status"] {
    if (m.status === "resolved") return "resolved";
    if (m.endDate.getTime() <= Date.now()) return "closed";
    return "open";
  }

  private summarize(m: Market): MarketSummary {
    const yes = lmsr.yesPrice(this.marketState(m));
    const traderIds = new Set<number>();
    for (const t of this.trades.values()) if (t.marketId === m.id) traderIds.add(t.userId);

    const dayAgo = Date.now() - 24 * 3600 * 1000;
    let priceDayAgo = yes;
    let bestBefore: PricePoint | undefined;
    for (const p of this.pricePoints.values()) {
      if (p.marketId !== m.id) continue;
      if (p.createdAt.getTime() <= dayAgo) {
        if (!bestBefore || p.createdAt > bestBefore.createdAt) bestBefore = p;
      }
    }
    if (bestBefore) priceDayAgo = bestBefore.yesPrice;
    else {
      // market younger than 24h: compare with first point
      let first: PricePoint | undefined;
      for (const p of this.pricePoints.values()) {
        if (p.marketId === m.id && (!first || p.createdAt < first.createdAt)) first = p;
      }
      if (first) priceDayAgo = first.yesPrice;
    }

    return {
      ...m,
      status: this.effectiveStatus(m),
      yesPrice: yes,
      noPrice: 1 - yes,
      traders: traderIds.size,
      change24h: yes - priceDayAgo,
      creator: this.publicUser(m.creatorId),
    };
  }

  async listMarkets(filters: MarketFilters): Promise<MarketSummary[]> {
    let list = Array.from(this.markets.values()).map((m) => this.summarize(m));

    if (filters.category && filters.category !== "All") {
      list = list.filter((m) => m.category === filters.category);
    }
    if (filters.status) {
      list = list.filter((m) => m.status === filters.status);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(
        (m) => m.question.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
      );
    }

    switch (filters.sort) {
      case "newest":
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case "ending":
        list.sort((a, b) => a.endDate.getTime() - b.endDate.getTime());
        break;
      case "trending":
        list.sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
        break;
      case "volume":
      default:
        list.sort((a, b) => b.volume - a.volume);
    }
    // featured markets float to the top for the default view
    if (!filters.sort || filters.sort === "volume") {
      list.sort((a, b) => Number(b.featured) - Number(a.featured));
    }
    return list;
  }

  async getMarketBySlug(slug: string, viewerId?: number): Promise<MarketDetail | undefined> {
    const m = Array.from(this.markets.values()).find((x) => x.slug === slug);
    if (!m) return undefined;

    const priceHistory = Array.from(this.pricePoints.values())
      .filter((p) => p.marketId === m.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ t: p.createdAt.toISOString(), p: p.yesPrice }));

    const recentTrades = Array.from(this.trades.values())
      .filter((t) => t.marketId === m.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 30)
      .map((t) => ({ ...t, user: this.publicUser(t.userId) }));

    const cmts = Array.from(this.comments.values())
      .filter((c) => c.marketId === m.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((c) => ({ ...c, user: this.publicUser(c.userId) }));

    const holders = Array.from(this.positions.values())
      .filter((p) => p.marketId === m.id && p.shares > 1e-6)
      .sort((a, b) => b.shares - a.shares)
      .slice(0, 20)
      .map((p) => ({ user: this.publicUser(p.userId), outcome: p.outcome as Outcome, shares: p.shares }));

    const myPositions = viewerId
      ? Array.from(this.positions.values()).filter((p) => p.marketId === m.id && p.userId === viewerId)
      : [];

    return { ...this.summarize(m), priceHistory, recentTrades, comments: cmts, holders, myPositions };
  }

  async createMarket(creatorId: number, input: CreateMarketInput): Promise<MarketSummary> {
    this.mustUser(creatorId);
    const id = this.ids.market++;
    let slug = slugify(input.question) || `market-${id}`;
    if (Array.from(this.markets.values()).some((m) => m.slug === slug)) slug = `${slug}-${id}`;

    const { qYes, qNo } = lmsr.initialQuantities(input.liquidity, input.initialProbability);
    const now = new Date();
    const market: Market = {
      id,
      slug,
      question: input.question,
      description: input.description,
      rules: input.rules,
      category: input.category,
      imageEmoji: input.imageEmoji,
      creatorId,
      status: "open",
      resolution: null,
      liquidity: input.liquidity,
      qYes,
      qNo,
      volume: 0,
      featured: false,
      endDate: new Date(input.endDate),
      createdAt: now,
      resolvedAt: null,
    };
    this.markets.set(id, market);
    this.recordPrice(market, now);
    return this.summarize(market);
  }

  async resolveMarket(marketId: number, userId: number, outcome: Outcome): Promise<MarketSummary> {
    const m = this.mustMarket(marketId);
    if (m.creatorId !== userId) throw new HttpError(403, "Only the market creator can resolve it");
    if (m.status === "resolved") throw new HttpError(400, "Market already resolved");

    // Pay out winning shares at $1 each.
    for (const p of this.positions.values()) {
      if (p.marketId !== marketId || p.shares <= 0) continue;
      const user = this.users.get(p.userId);
      if (!user) continue;
      const payout = p.outcome === outcome ? p.shares : 0;
      this.users.set(user.id, { ...user, balance: user.balance + payout });
      this.positions.set(p.id, {
        ...p,
        realizedPnl: p.realizedPnl + payout - p.costBasis,
        shares: 0,
        costBasis: 0,
      });
    }

    const resolved: Market = { ...m, status: "resolved", resolution: outcome, resolvedAt: new Date() };
    this.markets.set(marketId, resolved);
    // final price point pins the chart at 0 or 1
    const pid = this.ids.price++;
    this.pricePoints.set(pid, {
      id: pid,
      marketId,
      yesPrice: outcome === "YES" ? 1 : 0,
      createdAt: new Date(),
    });
    return this.summarize(resolved);
  }

  private recordPrice(m: Market, at: Date) {
    const id = this.ids.price++;
    this.pricePoints.set(id, { id, marketId: m.id, yesPrice: lmsr.yesPrice(this.marketState(m)), createdAt: at });
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  private getPosition(userId: number, marketId: number, outcome: Outcome): Position | undefined {
    for (const p of this.positions.values()) {
      if (p.userId === userId && p.marketId === marketId && p.outcome === outcome) return p;
    }
    return undefined;
  }

  private computeQuote(
    m: Market,
    user: User,
    outcome: Outcome,
    side: "buy" | "sell",
    amount: number,
  ): lmsr.Quote {
    if (this.effectiveStatus(m) !== "open") throw new HttpError(400, "This market is no longer trading");
    if (!(amount > 0)) throw new HttpError(400, "Amount must be positive");
    const state = this.marketState(m);

    if (side === "buy") {
      if (amount > user.balance + 1e-9) throw new HttpError(400, "Insufficient balance");
      return lmsr.quoteBuy(state, outcome, amount);
    }

    const pos = this.getPosition(user.id, m.id, outcome);
    const owned = pos?.shares ?? 0;
    if (amount > owned + 1e-6) throw new HttpError(400, "You don't own that many shares");
    return lmsr.quoteSell(state, outcome, Math.min(amount, owned));
  }

  async quote(marketId: number, userId: number, outcome: Outcome, side: "buy" | "sell", amount: number): Promise<TradeQuote> {
    const m = this.mustMarket(marketId);
    const user = this.mustUser(userId);
    const { nextState: _n, ...q } = this.computeQuote(m, user, outcome, side, amount);
    return q;
  }

  async trade(marketId: number, userId: number, outcome: Outcome, side: "buy" | "sell", amount: number) {
    const m = this.mustMarket(marketId);
    const user = this.mustUser(userId);
    const q = this.computeQuote(m, user, outcome, side, amount);
    if (q.shares <= 1e-9) throw new HttpError(400, "Trade too small");

    // position
    let pos = this.getPosition(userId, marketId, outcome);
    if (!pos) {
      pos = {
        id: this.ids.position++,
        userId,
        marketId,
        outcome,
        shares: 0,
        costBasis: 0,
        realizedPnl: 0,
      };
    }

    let newBalance = user.balance;
    if (side === "buy") {
      newBalance -= q.amount;
      pos = { ...pos, shares: pos.shares + q.shares, costBasis: pos.costBasis + q.amount };
    } else {
      newBalance += q.amount;
      const fraction = pos.shares > 0 ? q.shares / pos.shares : 1;
      const costOfSold = pos.costBasis * fraction;
      pos = {
        ...pos,
        shares: Math.max(0, pos.shares - q.shares),
        costBasis: Math.max(0, pos.costBasis - costOfSold),
        realizedPnl: pos.realizedPnl + (q.amount - costOfSold),
      };
      if (pos.shares < 1e-6) pos = { ...pos, shares: 0, costBasis: 0 };
    }
    this.positions.set(pos.id, pos);

    const updatedUser: User = { ...user, balance: newBalance };
    this.users.set(userId, updatedUser);

    const now = new Date();
    const updatedMarket: Market = {
      ...m,
      qYes: q.nextState.qYes,
      qNo: q.nextState.qNo,
      volume: m.volume + q.amount,
    };
    this.markets.set(marketId, updatedMarket);
    this.recordPrice(updatedMarket, now);

    const tradeId = this.ids.trade++;
    const trade: Trade = {
      id: tradeId,
      userId,
      marketId,
      outcome,
      side,
      shares: q.shares,
      amount: q.amount,
      avgPrice: q.avgPrice,
      priceAfter: q.priceAfter,
      createdAt: now,
    };
    this.trades.set(tradeId, trade);

    return { trade, market: this.summarize(updatedMarket), user: updatedUser };
  }

  // -------------------------------------------------------------------------
  // Social
  // -------------------------------------------------------------------------

  async addComment(marketId: number, userId: number, body: string) {
    this.mustMarket(marketId);
    this.mustUser(userId);
    const id = this.ids.comment++;
    const c: Comment = { id, marketId, userId, body, createdAt: new Date() };
    this.comments.set(id, c);
    return { ...c, user: this.publicUser(userId) };
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  private positionValue(p: Position): { price: number; value: number } {
    const m = this.markets.get(p.marketId);
    if (!m) return { price: 0, value: 0 };
    let price: number;
    if (m.status === "resolved") {
      price = m.resolution === p.outcome ? 1 : 0;
    } else {
      price = lmsr.price(this.marketState(m), p.outcome as Outcome);
    }
    return { price, value: price * p.shares };
  }

  async getPortfolio(userId: number): Promise<Portfolio> {
    const user = this.mustUser(userId);
    const mine = Array.from(this.positions.values()).filter((p) => p.userId === userId);

    let positionsValue = 0;
    let unrealized = 0;
    let realized = 0;
    const positions: PortfolioPosition[] = [];
    for (const p of mine) {
      realized += p.realizedPnl;
      if (p.shares <= 1e-6) continue;
      const { price, value } = this.positionValue(p);
      positionsValue += value;
      unrealized += value - p.costBasis;
      positions.push({
        ...p,
        market: this.summarize(this.mustMarket(p.marketId)),
        currentPrice: price,
        currentValue: value,
        unrealizedPnl: value - p.costBasis,
      });
    }
    positions.sort((a, b) => b.currentValue - a.currentValue);

    const trades = Array.from(this.trades.values())
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => {
        const m = this.mustMarket(t.marketId);
        return { ...t, market: { id: m.id, slug: m.slug, question: m.question, imageEmoji: m.imageEmoji } };
      });

    // Portfolio history approximated from cash flow: start at 1000, replay trades.
    const history: { t: string; v: number }[] = [];
    const chronological = [...trades].reverse();
    let cash = 1000;
    history.push({ t: user.createdAt.toISOString(), v: 1000 });
    for (const t of chronological) {
      cash += t.side === "buy" ? -t.amount : t.amount;
      // value positions at the trade's post-price is expensive; approximate with cash + shares*price at the time
      history.push({ t: t.createdAt.toISOString(), v: cash + (t.side === "buy" ? t.shares * t.avgPrice : 0) });
    }
    history.push({ t: new Date().toISOString(), v: user.balance + positionsValue });

    return {
      balance: user.balance,
      positionsValue,
      totalValue: user.balance + positionsValue,
      unrealizedPnl: unrealized,
      realizedPnl: realized,
      positions,
      trades,
      history,
    };
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const entries: LeaderboardEntry[] = [];
    for (const u of this.users.values()) {
      let positionsValue = 0;
      let realized = 0;
      let costBasis = 0;
      const marketIds = new Set<number>();
      for (const p of this.positions.values()) {
        if (p.userId !== u.id) continue;
        realized += p.realizedPnl;
        if (p.shares > 1e-6) {
          positionsValue += this.positionValue(p).value;
          costBasis += p.costBasis;
          marketIds.add(p.marketId);
        }
      }
      let volume = 0;
      for (const t of this.trades.values()) if (t.userId === u.id) volume += t.amount;
      if (volume === 0) continue;
      entries.push({
        user: this.publicUser(u.id),
        totalValue: u.balance + positionsValue,
        pnl: realized + (positionsValue - costBasis),
        volume,
        markets: marketIds.size,
      });
    }
    return entries.sort((a, b) => b.pnl - a.pnl).slice(0, 50);
  }

  async getActivity(limit: number): Promise<ActivityItem[]> {
    return Array.from(this.trades.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((t) => {
        const m = this.mustMarket(t.marketId);
        return {
          trade: t,
          user: this.publicUser(t.userId),
          market: { id: m.id, slug: m.slug, question: m.question, imageEmoji: m.imageEmoji },
        };
      });
  }

  // -------------------------------------------------------------------------
  // Seed data
  // -------------------------------------------------------------------------

  private seed() {
    // A handful of bot traders so the markets don't look empty.
    const bots: User[] = [];
    const botNames = ["oracle_dan", "cassandra", "quant_maria", "delphi", "nostradamus_jr", "polly", "hedgehog", "sybil"];
    for (const name of botNames) {
      const id = this.ids.user++;
      const u: User = {
        id,
        sessionId: `bot-${id}`,
        username: name,
        avatarSeed: name,
        balance: 1000,
        createdAt: new Date(Date.now() - 40 * 86400_000),
      };
      this.users.set(id, u);
      bots.push(u);
    }

    // Deterministic pseudo-random so seed output is stable between restarts.
    let seedVal = 42;
    const rand = () => {
      seedVal = (seedVal * 1664525 + 1013904223) % 4294967296;
      return seedVal / 4294967296;
    };

    for (const s of seedMarkets) {
      const id = this.ids.market++;
      const createdAt = new Date(Date.now() - s.ageDays * 86400_000);
      const { qYes, qNo } = lmsr.initialQuantities(s.liquidity, s.startProbability);
      const market: Market = {
        id,
        slug: slugify(s.question),
        question: s.question,
        description: s.description,
        rules: s.rules,
        category: s.category,
        imageEmoji: s.emoji,
        creatorId: bots[id % bots.length].id,
        status: "open",
        resolution: null,
        liquidity: s.liquidity,
        qYes,
        qNo,
        volume: 0,
        featured: !!s.featured,
        endDate: new Date(Date.now() + s.daysLeft * 86400_000),
        createdAt,
        resolvedAt: null,
      };
      this.markets.set(id, market);
      this.recordPrice(market, createdAt);

      // Simulate a random walk of bot trades that drifts toward the target probability.
      const steps = 40 + Math.floor(rand() * 40);
      const span = createdAt.getTime();
      const total = Date.now() - span;
      for (let i = 0; i < steps; i++) {
        const cur = this.markets.get(id)!;
        const p = lmsr.yesPrice(this.marketState(cur));
        const progress = (i + 1) / steps;
        const target = s.startProbability + (s.currentProbability - s.startProbability) * progress;
        const drift = target - p;
        // more likely to buy the side that moves toward target, with noise
        const buyYes = rand() < 0.5 + Math.max(-0.45, Math.min(0.45, drift * 4));
        const outcome: Outcome = buyYes ? "YES" : "NO";
        const amount = 5 + rand() * 60;
        const bot = bots[Math.floor(rand() * bots.length)];
        const at = new Date(span + total * ((i + 1) / (steps + 1)) + rand() * 1000);
        this.applySeedTrade(cur, bot, outcome, amount, at);
      }
      // Force the market to land very near the target probability with a final trade.
      const cur = this.markets.get(id)!;
      const state = this.marketState(cur);
      const target = lmsr.initialQuantities(cur.liquidity, s.currentProbability);
      const dYes = target.qYes - state.qYes;
      const dNo = target.qNo - state.qNo;
      // net shift: move only the positive direction to keep quantities non-negative
      const shift = dYes - dNo;
      if (Math.abs(shift) > 1e-6) {
        const outcome: Outcome = shift > 0 ? "YES" : "NO";
        const costNeeded = lmsr.costOfShares(state, outcome, Math.abs(shift));
        if (costNeeded > 0) {
          this.applySeedTrade(cur, bots[0], outcome, costNeeded, new Date(Date.now() - 60_000));
        }
      }

      for (const c of s.comments ?? []) {
        const cid = this.ids.comment++;
        this.comments.set(cid, {
          id: cid,
          marketId: id,
          userId: bots[Math.floor(rand() * bots.length)].id,
          body: c,
          createdAt: new Date(Date.now() - rand() * s.ageDays * 86400_000),
        });
      }
    }

    // Resolve one seed market so the UI has a resolved example.
    const toResolve = Array.from(this.markets.values()).find((m) => m.slug.startsWith("will-ethereum-etf"));
    if (toResolve) {
      const resolved: Market = {
        ...toResolve,
        status: "resolved",
        resolution: "YES",
        resolvedAt: new Date(Date.now() - 2 * 86400_000),
        endDate: new Date(Date.now() - 2 * 86400_000),
      };
      this.markets.set(toResolve.id, resolved);
      for (const p of this.positions.values()) {
        if (p.marketId !== toResolve.id || p.shares <= 0) continue;
        const user = this.users.get(p.userId)!;
        const payout = p.outcome === "YES" ? p.shares : 0;
        this.users.set(user.id, { ...user, balance: user.balance + payout });
        this.positions.set(p.id, { ...p, realizedPnl: p.realizedPnl + payout - p.costBasis, shares: 0, costBasis: 0 });
      }
      const pid = this.ids.price++;
      this.pricePoints.set(pid, { id: pid, marketId: toResolve.id, yesPrice: 1, createdAt: resolved.resolvedAt! });
    }
  }

  private applySeedTrade(m: Market, bot: User, outcome: Outcome, amount: number, at: Date) {
    const state = this.marketState(m);
    const q = lmsr.quoteBuy(state, outcome, amount);
    if (q.shares <= 0) return;
    let pos = this.getPosition(bot.id, m.id, outcome);
    if (!pos) {
      pos = { id: this.ids.position++, userId: bot.id, marketId: m.id, outcome, shares: 0, costBasis: 0, realizedPnl: 0 };
    }
    this.positions.set(pos.id, { ...pos, shares: pos.shares + q.shares, costBasis: pos.costBasis + q.amount });
    const current = this.users.get(bot.id)!;
    // bots have a bottomless wallet for seeding purposes; keep balance sane
    this.users.set(bot.id, { ...current, balance: Math.max(100, current.balance - q.amount) });

    const updated: Market = { ...m, qYes: q.nextState.qYes, qNo: q.nextState.qNo, volume: m.volume + q.amount };
    this.markets.set(m.id, updated);
    const pid = this.ids.price++;
    this.pricePoints.set(pid, { id: pid, marketId: m.id, yesPrice: q.priceAfter, createdAt: at });
    const tid = this.ids.trade++;
    this.trades.set(tid, {
      id: tid,
      userId: bot.id,
      marketId: m.id,
      outcome,
      side: "buy",
      shares: q.shares,
      amount: q.amount,
      avgPrice: q.avgPrice,
      priceAfter: q.priceAfter,
      createdAt: at,
    });
  }
}

export { randomUsername };
export const storage = new MemStorage();
