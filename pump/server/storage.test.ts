import assert from "node:assert/strict";
import test from "node:test";
import { CANDLE_INTERVAL_MS, TOTAL_SUPPLY, type CurveState } from "@shared/schema";
import { Storage, emptyCurve, restoreState, shortAddress } from "./storage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;
/** A deterministic, syntactically valid base58 address (no 0, O, I or l). */
function address(prefix: string): string {
  counter += 1;
  const head = prefix.replace(/[0OIl]/g, "x");
  const tail = String(counter).replace(/0/g, "9");
  return `${head}${"2".repeat(Math.max(0, 43 - head.length - tail.length))}${tail}`;
}

function curve(over: Partial<CurveState> = {}): CurveState {
  return { ...emptyCurve(), priceSol: 0.0000001, quoteReserveSol: 1, progress: 0.1, ...over };
}

interface Fixture {
  storage: Storage;
  ca: string;
  pool: string;
  creator: string;
  coinId: number;
}

function makeCoin(storage: Storage, over: { ticker?: string; name?: string; createdAt?: string; curve?: CurveState } = {}): Fixture {
  const ca = address("mint");
  const pool = address("pool");
  const creator = address("crea");
  const { coin } = storage.upsertCoinFromChain({
    ca,
    pool,
    name: over.name ?? "Test Coin",
    ticker: over.ticker ?? "TEST",
    metadataUri: `https://example.test/api/meta/${ca}.json`,
    creatorWallet: creator,
    curve: over.curve ?? curve(),
    createdAt: over.createdAt ?? new Date(Date.now() - 3_600_000).toISOString(),
    createdTx: "sig-create",
    description: "a test coin",
    imageUrl: "/uploads/coins/test.webp",
  });
  return { storage, ca, pool, creator, coinId: coin.id };
}

let signature = 0;
function trade(
  storage: Storage,
  coinId: number,
  input: { wallet: string; side: "buy" | "sell"; sol: number; tokens: number; priceSol: number; at?: string },
) {
  signature += 1;
  return storage.recordTrade({
    coinId,
    signature: `sig-${signature}`,
    wallet: input.wallet,
    side: input.side,
    sol: input.sol,
    tokens: input.tokens,
    feeSol: input.sol * 0.027,
    priceSol: input.priceSol,
    slot: 100 + signature,
    createdAt: input.at ?? new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

test("upsert adds a coin once and then only refreshes it", () => {
  const storage = new Storage();
  const { ca, pool, coinId } = makeCoin(storage);
  assert.equal(storage.listCoins().length, 1);

  const again = storage.upsertCoinFromChain({
    ca,
    pool,
    name: "Test Coin",
    ticker: "TEST",
    metadataUri: "",
    creatorWallet: address("crea"),
    curve: curve({ priceSol: 0.0000002, progress: 0.4 }),
  });
  assert.equal(again.created, false);
  assert.equal(again.coin.id, coinId);
  assert.equal(storage.listCoins().length, 1);
  // Locally stored metadata is not clobbered by a chain refresh.
  assert.equal(again.coin.description, "a test coin");
  assert.equal(again.coin.curve.progress, 0.4);
});

test("setCurve reports graduation exactly once", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const coin = storage.getCoin(coinId)!;
  assert.equal(storage.setCurve(coin, curve({ progress: 0.9 })), false);
  assert.equal(storage.setCurve(coin, curve({ progress: 1, completed: true })), true);
  assert.equal(storage.setCurve(coin, curve({ progress: 1, completed: true })), false);
});

test("a coin summary carries market cap, progress and the last trade", () => {
  const storage = new Storage();
  const { coinId, ca } = makeCoin(storage);
  const wallet = address("trad");
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 1_000_000, priceSol: 0.000001 });

  const summary = storage.listCoins().find((c) => c.ca === ca)!;
  assert.equal(summary.marketCapSol, summary.priceSol * TOTAL_SUPPLY);
  assert.equal(summary.progress, 0.1);
  assert.equal(summary.holders, 1);
  assert.equal(summary.lastTrade?.wallet, wallet);
  assert.equal(summary.creator.walletAddress, storage.getCoin(coinId)!.creatorWallet);
});

// ---------------------------------------------------------------------------
// Trades, candles, holdings
// ---------------------------------------------------------------------------

test("a trade updates volume, fees, counters and the holding", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const wallet = address("trad");

  const recorded = trade(storage, coinId, { wallet, side: "buy", sol: 2, tokens: 1_000_000, priceSol: 0.000002 });
  assert.ok(recorded);
  const coin = storage.getCoin(coinId)!;
  assert.equal(coin.buys, 1);
  assert.equal(coin.volumeSol, 2);
  assert.equal(coin.feesSol, 0.054);
  assert.equal(coin.lastTradeAt, recorded!.trade.createdAt);
  assert.equal(recorded!.trade.marketCapSol, 0.000002 * TOTAL_SUPPLY);

  const holding = storage.findHolding(wallet, coinId)!;
  assert.equal(holding.tokens, 1_000_000);
  assert.equal(holding.costBasisSol, 2);
});

test("the same signature is never indexed twice", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const wallet = address("trad");
  const input = {
    coinId,
    signature: "duplicate",
    wallet,
    side: "buy" as const,
    sol: 1,
    tokens: 100,
    feeSol: 0.027,
    priceSol: 0.01,
    slot: 1,
    createdAt: new Date().toISOString(),
  };
  assert.ok(storage.recordTrade(input));
  assert.equal(storage.recordTrade(input), null);
  assert.equal(storage.getCoin(coinId)!.buys, 1);
  assert.equal(storage.hasSignature("duplicate"), true);
});

test("selling realises PnL proportionally and empties the holding", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const wallet = address("trad");

  trade(storage, coinId, { wallet, side: "buy", sol: 2, tokens: 1_000_000, priceSol: 0.000002 });
  trade(storage, coinId, { wallet, side: "sell", sol: 1.5, tokens: 500_000, priceSol: 0.000003 });

  const holding = storage.findHolding(wallet, coinId)!;
  assert.equal(holding.tokens, 500_000);
  assert.equal(holding.costBasisSol, 1, "half of the cost basis stays with the remaining tokens");
  assert.equal(holding.realizedPnlSol, 0.5, "sold 1 SOL of cost for 1.5 SOL");

  trade(storage, coinId, { wallet, side: "sell", sol: 1, tokens: 500_000, priceSol: 0.000002 });
  const empty = storage.findHolding(wallet, coinId)!;
  assert.equal(empty.tokens, 0);
  assert.equal(empty.costBasisSol, 0);
  assert.equal(empty.realizedPnlSol, 0.5);
  assert.equal(storage.listCoins()[0].holders, 0, "an emptied holding is not a holder");
});

test("candles bucket trades by the minute and carry SOL volume", () => {
  const storage = new Storage();
  const base = Math.floor(Date.now() / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS - 10 * CANDLE_INTERVAL_MS;
  const { coinId } = makeCoin(storage, { createdAt: new Date(base).toISOString() });
  const wallet = address("trad");

  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 100, priceSol: 10, at: new Date(base + 1_000).toISOString() });
  trade(storage, coinId, { wallet, side: "buy", sol: 2, tokens: 100, priceSol: 12, at: new Date(base + 30_000).toISOString() });
  trade(storage, coinId, {
    wallet,
    side: "sell",
    sol: 1,
    tokens: 50,
    priceSol: 8,
    at: new Date(base + CANDLE_INTERVAL_MS + 1_000).toISOString(),
  });

  const candles = storage.getCandles(coinId);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].t, base);
  assert.equal(candles[0].o, 10, "the launch candle opens at the first traded price");
  assert.equal(candles[0].h, 12);
  assert.equal(candles[0].l, 10);
  assert.equal(candles[0].c, 12);
  assert.equal(candles[0].v, 3);
  assert.equal(candles[1].t, base + CANDLE_INTERVAL_MS);
  assert.equal(candles[1].o, 12, "the next candle opens where the previous closed");
  assert.equal(candles[1].c, 8);
  assert.equal(candles[1].v, 1);
});

test("candles are rebuilt after a new trade", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const wallet = address("trad");
  const before = storage.getCandles(coinId);
  assert.equal(before.length, 1, "an untraded coin still has one candle at its launch price");
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 100, priceSol: 5 });
  const after = storage.getCandles(coinId);
  assert.equal(after[after.length - 1].c, 5);
});

test("out-of-order backfilled trades keep the candle series chronological", () => {
  const storage = new Storage();
  const base = Date.now() - 10 * CANDLE_INTERVAL_MS;
  const { coinId } = makeCoin(storage, { createdAt: new Date(base).toISOString() });
  const wallet = address("trad");

  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 10, priceSol: 20, at: new Date(base + 5 * CANDLE_INTERVAL_MS).toISOString() });
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 10, priceSol: 10, at: new Date(base + CANDLE_INTERVAL_MS).toISOString() });

  const candles = storage.getCandles(coinId);
  const times = candles.map((c) => c.t);
  assert.deepEqual(times.slice().sort((a, b) => a - b), times, "candles are ordered in time");
  assert.equal(candles[candles.length - 1].c, 20, "the newest trade closes the series");
});

// ---------------------------------------------------------------------------
// Sorting & search
// ---------------------------------------------------------------------------

test("coins sort by new, mcap, volume, trending and graduated", () => {
  const storage = new Storage();
  const now = Date.now();
  const old = makeCoin(storage, { ticker: "OLD", createdAt: new Date(now - 5 * 86_400_000).toISOString(), curve: curve({ priceSol: 1 }) });
  const fresh = makeCoin(storage, { ticker: "FRESH", createdAt: new Date(now - 60_000).toISOString(), curve: curve({ priceSol: 0.5 }) });
  const done = makeCoin(storage, {
    ticker: "DONE",
    createdAt: new Date(now - 86_400_000).toISOString(),
    curve: curve({ priceSol: 0.1, progress: 1, completed: true }),
  });

  const wallet = address("trad");
  // OLD has the bigger lifetime volume, FRESH traded within the last 24h.
  trade(storage, old.coinId, { wallet, side: "buy", sol: 50, tokens: 10, priceSol: 1, at: new Date(now - 4 * 86_400_000).toISOString() });
  trade(storage, fresh.coinId, { wallet, side: "buy", sol: 10, tokens: 10, priceSol: 0.5, at: new Date(now - 30_000).toISOString() });

  assert.deepEqual(storage.listCoins({ sort: "new" }).map((c) => c.ticker), ["FRESH", "DONE", "OLD"]);
  assert.deepEqual(storage.listCoins({ sort: "mcap" }).map((c) => c.ticker), ["OLD", "FRESH", "DONE"]);
  assert.deepEqual(storage.listCoins({ sort: "volume" }).map((c) => c.ticker), ["OLD", "FRESH", "DONE"]);
  assert.equal(storage.listCoins({ sort: "trending" })[0].ticker, "FRESH", "24h volume beats lifetime volume");
  assert.deepEqual(storage.listCoins({ sort: "graduated" }).map((c) => c.ticker), ["DONE"]);
  assert.equal(storage.listCoins({ limit: 2 }).length, 2);
});

test("search matches name, ticker, description and the exact mint", () => {
  const storage = new Storage();
  const { ca } = makeCoin(storage, { name: "Solana Dog", ticker: "SDOG" });
  makeCoin(storage, { name: "Other", ticker: "OTHER" });

  assert.equal(storage.listCoins({ search: "solana dog" }).length, 1);
  assert.equal(storage.listCoins({ search: "sdog" })[0].ticker, "SDOG");
  assert.equal(storage.listCoins({ search: "a test coin" }).length, 2, "both share the seeded description");
  assert.equal(storage.listCoins({ search: ca })[0].ca, ca);
  assert.equal(storage.listCoins({ search: "nothing here" }).length, 0);
});

test("24h change is measured against the price 24h ago", () => {
  const storage = new Storage();
  const now = Date.now();
  const { coinId, ca } = makeCoin(storage, { createdAt: new Date(now - 3 * 86_400_000).toISOString(), curve: curve({ priceSol: 2 }) });
  const wallet = address("trad");
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 1, priceSol: 1, at: new Date(now - 2 * 86_400_000).toISOString() });
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 1, priceSol: 2, at: new Date(now - 60_000).toISOString() });

  const summary = storage.listCoins().find((c) => c.ca === ca)!;
  assert.equal(summary.change24h, 1, "price doubled versus the reference 24h ago");
});

// ---------------------------------------------------------------------------
// Users, wallets, portfolio
// ---------------------------------------------------------------------------

test("wallet users are keyed by their base58 address", () => {
  const storage = new Storage();
  const wallet = address("wall");
  const { user, created } = storage.findOrCreateWalletUser(wallet);
  assert.equal(created, true);
  assert.equal(user.walletAddress, wallet);
  assert.equal(user.provider, "wallet");
  assert.equal(storage.findOrCreateWalletUser(wallet).created, false);
  assert.equal(storage.getUserByWallet(wallet)?.id, user.id);
  // Case matters on Solana: the lower-cased address is a different wallet.
  const mixedCase = "AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK";
  storage.findOrCreateWalletUser(mixedCase);
  assert.ok(storage.getUserByWallet(mixedCase));
  assert.equal(storage.getUserByWallet(mixedCase.toLowerCase()), undefined);
});

test("linking a wallet claims the coins and trades already indexed for it", () => {
  const storage = new Storage();
  const wallet = address("wall");
  const { coinId } = (() => {
    const fixture = makeCoin(storage);
    const coin = storage.getCoin(fixture.coinId)!;
    coin.creatorWallet = wallet;
    return fixture;
  })();
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 10, priceSol: 0.1 });

  const { user } = storage.findOrCreateUser("someone@example.test", "email");
  storage.linkWallet(user.id, wallet);

  assert.equal(storage.getCoin(coinId)!.creatorId, user.id);
  assert.equal(storage.getCoinTrades(coinId)[0].userId, user.id);
  assert.throws(() => {
    const other = storage.findOrCreateUser("other@example.test", "email").user;
    storage.linkWallet(other.id, wallet);
  });
});

test("the portfolio values holdings at the current curve price", () => {
  const storage = new Storage();
  const { coinId, ca } = makeCoin(storage, { curve: curve({ priceSol: 0.000004 }) });
  const wallet = address("trad");
  trade(storage, coinId, { wallet, side: "buy", sol: 2, tokens: 1_000_000, priceSol: 0.000002 });

  const portfolio = storage.getPortfolio(wallet);
  assert.equal(portfolio.wallet, wallet);
  assert.equal(portfolio.holdings.length, 1);
  assert.equal(portfolio.holdings[0].coin.ca, ca);
  assert.equal(portfolio.holdings[0].valueSol, 4);
  assert.equal(portfolio.holdings[0].unrealizedPnlSol, 2);
  assert.equal(portfolio.holdingsValueSol, 4);
  assert.equal(portfolio.trades.length, 1);
  assert.equal(storage.getPortfolio(null).holdings.length, 0);
});

test("platform stats count coins, traders, volume and graduations", () => {
  const storage = new Storage();
  const a = makeCoin(storage);
  const b = makeCoin(storage, { curve: curve({ progress: 1, completed: true }) });
  trade(storage, a.coinId, { wallet: address("t1"), side: "buy", sol: 1, tokens: 10, priceSol: 0.1 });
  trade(storage, b.coinId, { wallet: address("t2"), side: "buy", sol: 2, tokens: 10, priceSol: 0.2 });

  const stats = storage.getStats();
  assert.equal(stats.coins, 2);
  assert.equal(stats.trades, 2);
  assert.equal(stats.traders, 2);
  assert.equal(stats.volumeSol, 3);
  assert.equal(stats.graduated, 1);
});

test("activity is newest first and carries the coin reference", () => {
  const storage = new Storage();
  const { coinId, ca } = makeCoin(storage);
  const wallet = address("trad");
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 10, priceSol: 1, at: new Date(Date.now() - 60_000).toISOString() });
  trade(storage, coinId, { wallet, side: "sell", sol: 2, tokens: 5, priceSol: 2, at: new Date().toISOString() });

  const activity = storage.getActivity(10);
  assert.equal(activity.length, 2);
  assert.equal(activity[0].trade.side, "sell");
  assert.equal(activity[0].coin.ca, ca);
  assert.equal(storage.getActivity(1).length, 1);
});

// ---------------------------------------------------------------------------
// Comments & persistence
// ---------------------------------------------------------------------------

test("comments carry the author's holding and toggle likes", () => {
  const storage = new Storage();
  const { coinId } = makeCoin(storage);
  const wallet = address("wall");
  const { user } = storage.findOrCreateWalletUser(wallet);
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 42, priceSol: 0.02 });

  const comment = storage.addComment(coinId, user.id, "  gm  ");
  assert.equal(comment.body, "gm");
  assert.equal(comment.holding, 42);

  assert.deepEqual(storage.toggleLike(comment.id, user.id).likes, [user.id]);
  assert.deepEqual(storage.toggleLike(comment.id, user.id).likes, []);
  assert.equal(storage.listComments(coinId).length, 1);
  assert.equal(storage.getCommentCoinCa(comment.id), storage.getCoin(coinId)!.ca);
});

test("a snapshot round-trips through restore()", () => {
  const storage = new Storage();
  const { coinId, ca } = makeCoin(storage);
  const wallet = address("wall");
  const { user } = storage.findOrCreateWalletUser(wallet);
  trade(storage, coinId, { wallet, side: "buy", sol: 1, tokens: 100, priceSol: 0.01 });
  storage.addComment(coinId, user.id, "wagmi");
  storage.setCursor(storage.getCoin(coinId)!.pool, "cursor-sig");

  const json = JSON.stringify(storage.snapshot());
  const restored = new Storage();
  restored.restore(json);

  assert.equal(restored.listCoins().length, 1);
  assert.equal(restored.findCoinByCa(ca)?.id, coinId);
  assert.equal(restored.getCoinTrades(coinId).length, 1);
  assert.equal(restored.findHolding(wallet, coinId)?.tokens, 100);
  assert.equal(restored.listComments(coinId).length, 1);
  assert.equal(restored.getCursor(storage.getCoin(coinId)!.pool), "cursor-sig");
  assert.equal(restored.getUserByWallet(wallet)?.id, user.id);
});

test("restoreState fills in fields a older snapshot is missing", () => {
  const state = restoreState(JSON.stringify({ coins: [{ id: 3, ca: "abc", ticker: "ABC" }], trades: [{ id: 9 }] }));
  assert.equal(state.version, 2);
  assert.equal(state.coins[0].curve.baseReserve, TOTAL_SUPPLY);
  assert.equal(state.coins[0].volumeSol, 0);
  assert.equal(state.ids.coin, 4, "ids continue above the highest stored one");
  assert.equal(state.ids.trade, 10);
  assert.deepEqual(state.cursors, {});
  assert.throws(() => restoreState("[]"));
});

test("shortAddress abbreviates long base58 addresses only", () => {
  assert.equal(shortAddress("7xKXtgnoxia"), "7xKX…oxia");
  assert.equal(shortAddress("short"), "short");
});
