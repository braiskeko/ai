import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANDLE_INTERVAL_MS, GRADUATION_MCAP, KING_MCAP, SWAP_FEE, TOTAL_SUPPLY, type CreateCoinInput, type User } from "../shared/schema";
import { isValidCa } from "./ca";
import * as curve from "./curve";

// `server/config.ts` reads the environment once, when it is first imported, so the
// environment has to be prepared BEFORE storage.ts (which imports config.ts) is
// loaded. Hence the dynamic import below instead of a static one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "noxia-storage-test-"));
const dataFile = path.join(tmpDir, "nested", "state.json");
process.env.DATA_FILE = dataFile;
process.env.CHAIN = "amoy"; // testnet: faucet enabled
process.env.DEPOSITS_ENABLED = "0";
delete process.env.DATABASE_URL;
delete process.env.ADMIN_EMAILS;
delete process.env.INITIAL_CREDITS;

const { Storage, HttpError, initStorage, selloutMarketCap, MIN_BUY_USDC } = await import("./storage");
type StorageInstance = InstanceType<typeof Storage>;

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const deriveDepositAddress = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

function fresh(): StorageInstance {
  return new Storage({ deriveDepositAddress });
}

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function coinInput(overrides: Partial<CreateCoinInput> = {}): CreateCoinInput {
  return {
    name: "Test Coin",
    ticker: "TEST",
    description: "A coin for tests",
    image: IMAGE,
    website: "",
    twitter: "",
    telegram: "",
    creatorAllocation: 0,
    initialBuy: 0,
    ...overrides,
  };
}

/** A signed-up user holding `balance` USDC (credited through the admin path). */
function funded(s: StorageInstance, name: string, balance: number): User {
  const { user } = s.findOrCreateUser(`${name}@example.com`, "email", name);
  if (balance > 0) s.adminCreditBalance(user.username, balance);
  return user;
}

function assertHttp(fn: () => unknown, status: number, messagePart?: string | RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (messagePart) assert.match(err.message, messagePart instanceof RegExp ? messagePart : new RegExp(messagePart));
    return true;
  });
}

const approx = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe("users", () => {
  it("findOrCreateUser creates once, the first account is admin, usernames are unique", () => {
    const s = fresh();
    const a = s.findOrCreateUser("Alice@Example.com", "google", "Alice");
    assert.equal(a.created, true);
    assert.equal(a.user.email, "alice@example.com");
    assert.equal(a.user.username, "Alice");
    assert.equal(a.user.isAdmin, true, "first real account bootstraps admin");
    assert.equal(a.user.depositIndex, 0);
    assert.equal(a.user.depositAddress, deriveDepositAddress(0));
    assert.equal(a.user.balance, 0);
    assert.equal(a.user.creatorEarnings, 0);
    assert.equal(a.user.walletAddress, null);
    assert.equal(a.user.avatarUrl, null);

    const again = s.findOrCreateUser("alice@example.com", "email");
    assert.equal(again.created, false);
    assert.equal(again.user.id, a.user.id);

    const b = s.findOrCreateUser("alice@other.com", "email", "Alice");
    assert.equal(b.user.username, "Alice2", "clashing handle gets a numeric suffix");
    assert.equal(b.user.isAdmin, false);
    assert.equal(b.user.depositIndex, 1);
    assert.equal(s.getUserByUsername("@ALICE2")?.id, b.user.id);
    assert.equal(s.getUserByEmail(" ALICE@EXAMPLE.COM ")?.id, a.user.id);
  });

  it("findOrCreateWalletUser keys the account by checksummed address", () => {
    const s = fresh();
    const lower = "0xab5801a7d398351b8be11c439e05c5b3259aec9b";
    const { user, created } = s.findOrCreateWalletUser(lower);
    assert.equal(created, true);
    assert.equal(user.provider, "wallet");
    assert.equal(user.walletAddress, "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B");
    assert.equal(user.email, `${lower}@wallet.local`);
    assert.equal(user.username, "ab58_ec9b");

    const again = s.findOrCreateWalletUser(lower.toUpperCase().replace("0X", "0x"));
    assert.equal(again.created, false);
    assert.equal(again.user.id, user.id);
    assert.equal(s.getUserByWallet(lower.toUpperCase().replace("0X", "0x"))?.id, user.id);
    assert.equal(s.getUserByEmail(`${lower}@wallet.local`)?.id, user.id);
    assertHttp(() => s.findOrCreateWalletUser("0x1234"), 400, /wallet address/i);
    assert.equal(s.getUserByWallet("nope"), undefined);
  });

  it("setAvatar / updateUsername / toSafeUser / toPublicUser", () => {
    const s = fresh();
    const { user } = s.findOrCreateUser("bob@example.com", "email", "bob");
    s.setAvatar(user.id, "/uploads/avatars/1.webp");
    assert.equal(s.getUser(user.id)?.avatarUrl, "/uploads/avatars/1.webp");
    assert.deepEqual(s.toPublicUser(user.id), {
      id: user.id,
      username: "bob",
      avatarSeed: user.avatarSeed,
      avatarUrl: "/uploads/avatars/1.webp",
    });
    assert.equal("depositIndex" in s.toSafeUser(user), false);
    s.updateUsername(user.id, "bobby");
    assert.equal(s.getUserByUsername("bobby")?.id, user.id);
    s.findOrCreateUser("carl@example.com", "email", "carl");
    assertHttp(() => s.updateUsername(user.id, "CARL"), 409);
    assert.equal(s.toPublicUser(9999).username, "unknown");
  });

  it("admin credits apply immediately or queue for a future username", () => {
    const s = fresh();
    const { user } = s.findOrCreateUser("dan@example.com", "email", "dan");
    assert.deepEqual(s.adminCreditBalance("@dan", 250).queued, false);
    assert.equal(s.getUser(user.id)?.balance, 250);
    assertHttp(() => s.adminCreditBalance("dan", -1000), 400, /below zero/);
    assertHttp(() => s.adminCreditBalance("nobody", -5), 404);
    assertHttp(() => s.adminCreditBalance("x", 5), 400);
    assertHttp(() => s.adminCreditBalance("dan", 0), 400);

    const queued = s.adminCreditBalance("ghost", 40);
    assert.equal(queued.user, null);
    assert.equal(queued.queued, true);
    s.adminCreditBalance("ghost", 2);
    assert.equal(s.snapshot().pendingCredits.ghost, 42);

    const ghost = s.findOrCreateUser("ghost@example.com", "email", "Ghost").user;
    assert.equal(ghost.balance, 42, "queued credit lands on sign-up (case-insensitive)");
    assert.equal(s.snapshot().pendingCredits.ghost, undefined);

    s.adminCreditBalance("renamed", 7);
    s.updateUsername(user.id, "renamed");
    assert.equal(s.getUser(user.id)?.balance, 257, "queued credit lands on rename");
  });

  it("applyInitialCredits applies each entry exactly once", () => {
    const s = fresh();
    funded(s, "eve", 0);
    s.applyInitialCredits("eve:100, eve:100,bogus,zed:-3,:5");
    assert.equal(s.getUserByUsername("eve")?.balance, 100, "duplicate entry is applied once");
    s.applyInitialCredits("eve:100");
    assert.equal(s.getUserByUsername("eve")?.balance, 100, "re-running at boot does not double credit");
    s.applyInitialCredits("eve:50");
    assert.equal(s.getUserByUsername("eve")?.balance, 150);
    assert.deepEqual(s.snapshot().appliedCredits, ["eve:100", "eve:50"]);
  });

  it("listUsers hides bots and filters by handle / email / wallet", () => {
    const s = fresh();
    funded(s, "frank", 10);
    s.findOrCreateWalletUser("0xab5801a7d398351b8be11c439e05c5b3259aec9b");
    assert.equal(s.listUsers().length, 2);
    assert.equal(s.listUsers("FRANK")[0]?.username, "frank");
    assert.equal(s.listUsers("0xab58").length, 1);
    assert.equal(s.listUsers("zzz").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

describe("createCoin", () => {
  it("generates a valid 44-char CA ending in noxia, unique across 200 coins", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const cas = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { coin } = s.createCoin(creator, coinInput({ name: `Coin ${i}`, ticker: `C${i}` }), IMAGE);
      assert.equal(coin.ca.length, 44);
      assert.ok(coin.ca.endsWith("noxia"));
      assert.ok(isValidCa(coin.ca), `invalid CA ${coin.ca}`);
      assert.ok(!cas.has(coin.ca), `duplicate CA ${coin.ca}`);
      cas.add(coin.ca);
      assert.equal(s.findCoinByCa(coin.ca)?.id, coin.id);
    }
    assert.equal(s.listCoins({ limit: 500 }).length, 200);
    assert.equal(s.getStats().coins, 200);
  });

  it("mints the creator allocation, starts on the launch curve and returns a full detail", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const { coin, trade } = s.createCoin(
      creator,
      coinInput({ creatorAllocation: 0.1, ticker: "abc", website: "https://x.yz", twitter: "", telegram: "  " }),
      "/uploads/coins/x.webp",
    );
    assert.equal(trade, null);
    assert.equal(coin.ticker, "ABC");
    assert.equal(coin.imageUrl, "/uploads/coins/x.webp");
    assert.equal(coin.website, "https://x.yz");
    assert.equal(coin.twitter, null);
    assert.equal(coin.telegram, null);
    assert.equal(coin.creatorId, creator.id);
    assert.equal(coin.creator.username, "creator");
    approx(coin.curveTokens, TOTAL_SUPPLY * 0.9, 1e-3);
    approx(coin.circulating, TOTAL_SUPPLY * 0.1, 1e-3);
    assert.equal(coin.realUsdc, 0);
    approx(coin.price, curve.spotPrice(curve.initialCurve(0.1)), 1e-15);
    approx(coin.marketCap, curve.marketCap(curve.initialCurve(0.1)), 1e-6);
    assert.equal(coin.holders, 1, "creator allocation counts as a holder");
    assert.equal(coin.comments, 0);
    assert.equal(coin.change24h, 0);
    assert.equal(coin.lastTrade, null);
    assert.equal(coin.graduated, false);
    assert.equal(coin.recentTrades.length, 0);
    assert.equal(coin.topHolders.length, 1);
    assert.equal(coin.topHolders[0].isCreator, true);
    approx(coin.topHolders[0].share, 0.1, 1e-12);
    assert.ok(coin.myHolding && Math.abs(coin.myHolding.tokens - TOTAL_SUPPLY * 0.1) < 1e-3);
    assert.equal(coin.myHolding?.costBasis, 0);
    // synthetic launch candle
    assert.equal(coin.candles.length, 1);
    const c = coin.candles[0];
    assert.equal(c.t, Math.floor(Date.parse(coin.createdAt) / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS);
    assert.equal(c.o, coin.price);
    assert.equal(c.h, coin.price);
    assert.equal(c.l, coin.price);
    assert.equal(c.c, coin.price);
    assert.equal(c.v, 0);
    assert.equal(s.getCoinByCa(coin.ca)?.myHolding, null, "no viewer -> no holding");
  });

  it("executes the creator's initial buy from their balance and refuses when they cannot afford it", () => {
    const s = fresh();
    const creator = funded(s, "creator", 100);
    assertHttp(() => s.createCoin(creator, coinInput({ initialBuy: 150 }), IMAGE), 400, /Insufficient/);
    assert.equal(s.listCoins().length, 0, "nothing is created when the initial buy fails");

    const { coin, trade } = s.createCoin(creator, coinInput({ initialBuy: 60 }), IMAGE);
    assert.ok(trade);
    assert.equal(trade.side, "buy");
    assert.equal(trade.usdc, 60);
    assert.equal(trade.coinId, coin.id);
    assert.equal(trade.userId, creator.id);
    // The creator paid 60, but earned back the creator share of the fee.
    const fee = Math.round(60 * SWAP_FEE * 1e6) / 1e6;
    const creatorFee = Math.round(fee * 0.1 * 1e6) / 1e6;
    approx(s.getUser(creator.id)!.balance, 100 - 60 + creatorFee);
    approx(s.getUser(creator.id)!.creatorEarnings, creatorFee);
    approx(coin.realUsdc, 60 - fee);
    assert.equal(coin.buys, 1);
    assert.equal(coin.volume, 60);
    assert.equal(coin.holders, 1);
    assert.equal(coin.recentTrades.length, 1);
    assert.equal(coin.lastTrade?.id, trade.id);
    assert.equal(coin.candles.length, 1, "the launch buy folds into the launch candle");
    assert.equal(coin.candles[0].v, 60);
    assert.equal(coin.candles[0].c, trade.price);
    approx(s.snapshot().platformRevenue, fee - creatorFee);
  });
});

describe("trading", () => {
  it("buy then sell round trip updates balances, holdings, creator earnings and coin stats", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 1000);
    const { coin } = s.createCoin(creator, coinInput({ creatorAllocation: 0.05 }), IMAGE);

    const q = s.quote(coin.id, trader.id, "buy", 100);
    assert.equal(q.side, "buy");
    assert.equal(q.amountIn, 100);
    assert.ok(q.amountOut > 0);
    assert.ok(q.priceAfter > q.priceBefore && q.priceImpact > 0);
    approx(q.marketCapAfter, q.priceAfter * TOTAL_SUPPLY, 1e-6);

    const buy = s.trade(coin.id, trader.id, "buy", 100);
    assert.equal(buy.user.id, trader.id);
    assert.equal(buy.trade.side, "buy");
    assert.equal(buy.trade.usdc, 100);
    approx(buy.trade.tokens, q.amountOut, 1e-6);
    assert.equal(buy.trade.fee, q.fee);
    assert.equal(buy.trade.price, q.priceAfter);
    approx(buy.trade.marketCap, q.marketCapAfter, 1e-6);
    assert.equal(s.getUser(trader.id)!.balance, 900);

    const fee = buy.trade.fee;
    const creatorFee = Math.round(fee * 0.1 * 1e6) / 1e6;
    approx(s.getUser(creator.id)!.balance, creatorFee);
    approx(s.getUser(creator.id)!.creatorEarnings, creatorFee);
    approx(s.snapshot().platformRevenue, fee - creatorFee);

    assert.equal(buy.coin.buys, 1);
    assert.equal(buy.coin.sells, 0);
    assert.equal(buy.coin.volume, 100);
    approx(buy.coin.realUsdc, 100 - fee);
    approx(buy.coin.feesCollected, fee);
    approx(buy.coin.creatorFees, creatorFee);
    approx(buy.coin.circulating, TOTAL_SUPPLY * 0.05 + buy.trade.tokens, 1e-3);
    approx(buy.coin.curveTokens, TOTAL_SUPPLY * 0.95 - buy.trade.tokens, 1e-3);
    assert.equal(buy.coin.holders, 2);
    assert.equal(buy.coin.lastTradeAt, buy.trade.createdAt);
    assert.equal(buy.coin.lastTrade?.user.username, "trader");
    assert.ok(buy.coin.change24h > 0, "price is up versus the launch price");

    const detail = s.getCoinByCa(coin.ca, trader.id)!;
    assert.ok(detail.myHolding);
    approx(detail.myHolding.tokens, buy.trade.tokens, 1e-6);
    assert.equal(detail.myHolding.costBasis, 100);
    assert.equal(detail.myHolding.realizedPnl, 0);
    assert.equal(detail.topHolders.length, 2);
    assert.equal(detail.topHolders[0].isCreator, true, "5% allocation is the biggest bag");

    // Sell everything.
    const owned = detail.myHolding.tokens;
    assertHttp(() => s.trade(coin.id, trader.id, "sell", owned * 1.01), 400, /that many/);
    const sq = s.quote(coin.id, trader.id, "sell", owned);
    assert.ok(sq.amountOut < 100, "fees make the round trip lossy");
    const sell = s.trade(coin.id, trader.id, "sell", owned);
    assert.equal(sell.trade.side, "sell");
    approx(sell.trade.tokens, owned, 1e-6);
    assert.equal(sell.trade.usdc, sq.amountOut);
    approx(s.getUser(trader.id)!.balance, 900 + sq.amountOut);

    const after = s.getCoinByCa(coin.ca, trader.id)!;
    assert.equal(after.myHolding, null, "emptied holding is not reported");
    assert.equal(after.holders, 1);
    assert.equal(after.sells, 1);
    approx(after.volume, 100 + sq.amountOut);
    approx(after.circulating, TOTAL_SUPPLY * 0.05, 1e-3);
    assert.ok(after.realUsdc >= 0 && after.realUsdc < 0.01, `curve nearly drained: ${after.realUsdc}`);
    assert.equal(after.recentTrades.length, 2);
    assert.equal(after.recentTrades[0].side, "sell", "newest first");

    const holding = s.snapshot().holdings.find((h) => h.userId === trader.id && h.coinId === coin.id)!;
    assert.equal(holding.tokens, 0);
    assert.equal(holding.costBasis, 0);
    approx(holding.realizedPnl, sq.amountOut - 100);

    // Creator was paid on both legs.
    const sellCreatorFee = Math.round(sell.trade.fee * 0.1 * 1e6) / 1e6;
    approx(s.getUser(creator.id)!.creatorEarnings, creatorFee + sellCreatorFee);
    approx(s.getUser(creator.id)!.balance, creatorFee + sellCreatorFee);

    const pf = s.getPortfolio(trader.id);
    assert.equal(pf.holdings.length, 0);
    assert.equal(pf.trades.length, 2);
    assert.equal(pf.trades[0].coin.ca, coin.ca);
    approx(pf.realizedPnl, sq.amountOut - 100);
    approx(pf.totalValue, pf.balance);
    assert.deepEqual(s.getStats(), { coins: 1, volume: Math.round((100 + sq.amountOut) * 1e6) / 1e6, traders: 1, trades: 2 });
    assert.equal(s.getActivity(10).length, 2);
    assert.equal(s.getActivity(1)[0].trade.id, sell.trade.id);
  });

  it("partial sells reduce the cost basis proportionally", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 500);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    const buy = s.trade(coin.id, trader.id, "buy", 200);
    const half = buy.trade.tokens / 2;
    const sell = s.trade(coin.id, trader.id, "sell", half);
    const holding = s.snapshot().holdings.find((h) => h.userId === trader.id && h.coinId === coin.id)!;
    approx(holding.tokens, half, 1e-6);
    approx(holding.costBasis, 100);
    approx(holding.realizedPnl, sell.trade.usdc - 100);
    const pf = s.getPortfolio(trader.id);
    assert.equal(pf.holdings.length, 1);
    approx(pf.holdings[0].value, pf.holdings[0].coin.price * half);
    approx(pf.holdings[0].unrealizedPnl, pf.holdings[0].value - 100);
    approx(pf.holdingsValue, pf.holdings[0].value);
    approx(pf.totalValue, pf.balance + pf.holdingsValue);
  });

  it("rejects fills worse than minOut with 400 'Price moved'", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 1000);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);

    const q = s.quote(coin.id, trader.id, "buy", 50);
    assertHttp(() => s.trade(coin.id, trader.id, "buy", 50, q.amountOut * 1.001), 400, /Price moved/);
    assert.equal(s.getUser(trader.id)!.balance, 1000, "rejected trade changes nothing");
    assert.equal(s.getCoinByCa(coin.ca)!.buys, 0);
    const ok = s.trade(coin.id, trader.id, "buy", 50, q.amountOut * 0.95);
    approx(ok.trade.tokens, q.amountOut, 1e-6);

    const sq = s.quote(coin.id, trader.id, "sell", ok.trade.tokens);
    assertHttp(() => s.trade(coin.id, trader.id, "sell", ok.trade.tokens, sq.amountOut + 0.01), 400, /Price moved/);
    const sold = s.trade(coin.id, trader.id, "sell", ok.trade.tokens, sq.amountOut * 0.95);
    assert.equal(sold.trade.usdc, sq.amountOut);
    // minOut of 0 / undefined never blocks
    s.trade(coin.id, trader.id, "buy", 10, 0);
  });

  it("validates amounts, balances and holdings", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 20);
    const stranger = funded(s, "stranger", 0);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    assertHttp(() => s.quote(coin.id, trader.id, "buy", 0), 400);
    assertHttp(() => s.quote(coin.id, trader.id, "buy", -1), 400);
    assertHttp(() => s.quote(coin.id, trader.id, "buy", MIN_BUY_USDC / 2), 400, /Minimum/);
    assertHttp(() => s.quote(coin.id, trader.id, "buy", 20.01), 400, /Insufficient/);
    assertHttp(() => s.quote(coin.id, stranger.id, "sell", 1), 400, /hold/);
    assertHttp(() => s.quote(9999, trader.id, "buy", 5), 404);
    assertHttp(() => s.quote(coin.id, 9999, "buy", 5), 404);
    s.trade(coin.id, trader.id, "buy", 20);
    assert.equal(s.getUser(trader.id)!.balance, 0);
    assertHttp(() => s.trade(coin.id, trader.id, "buy", 1), 400, /Insufficient/);
  });

  it("a buy larger than the remaining curve only charges for what is left, then the coin is sold out", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const whale = funded(s, "whale", 1e9);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    const all = curve.usdcForTokens(curve.initialCurve(0), TOTAL_SUPPLY);
    const q = s.quote(coin.id, whale.id, "buy", 1e9);
    assert.ok(q.amountIn <= all + 1e-6 && q.amountIn > all * 0.999, `charged ${q.amountIn} for the whole curve (${all})`);
    approx(q.amountOut, TOTAL_SUPPLY, 1e-3);
    const t = s.trade(coin.id, whale.id, "buy", 1e9);
    approx(t.trade.usdc, q.amountIn);
    approx(s.getUser(whale.id)!.balance, 1e9 - q.amountIn, 1e-3);
    assert.ok(t.coin.curveTokens < 1e-3);
    assertHttp(() => s.quote(coin.id, whale.id, "buy", 5), 400, /sold out/);
    assert.equal(t.coin.graduated, selloutMarketCap(0) >= GRADUATION_MCAP, "graduated iff the sell-out cap reaches GRADUATION_MCAP");
    if (t.coin.graduated) assert.equal(t.coin.graduatedAt, t.trade.createdAt);
    // Selling still works after a sell-out.
    const back = s.trade(coin.id, whale.id, "sell", t.trade.tokens / 2);
    assert.ok(back.trade.usdc > 0);
    assert.ok(s.quote(coin.id, whale.id, "buy", 5).amountOut > 0, "buys resume once tokens return to the curve");
  });
});

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

describe("candles", () => {
  it("aggregate trades into 1-minute OHLC buckets after the synthetic launch candle", (t) => {
    const T0 = Date.UTC(2026, 8, 5, 12, 0, 7); // 12:00:07 -> bucket 12:00:00
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 10_000);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    const launch = coin.price;
    const bucket0 = Date.UTC(2026, 8, 5, 12, 0, 0);

    const before = s.getCandles(coin.id);
    assert.deepEqual(before, [{ t: bucket0, o: launch, h: launch, l: launch, c: launch, v: 0 }]);

    t.mock.timers.setTime(T0 + 10_000); // still 12:00
    const t1 = s.trade(coin.id, trader.id, "buy", 100).trade;
    t.mock.timers.setTime(T0 + 70_000); // 12:01
    const t2 = s.trade(coin.id, trader.id, "buy", 300).trade;
    t.mock.timers.setTime(T0 + 130_000); // 12:02
    const t3 = s.trade(coin.id, trader.id, "sell", t2.tokens).trade;
    t.mock.timers.setTime(T0 + 150_000); // 12:02
    const t4 = s.trade(coin.id, trader.id, "buy", 50).trade;
    t.mock.timers.setTime(T0 + 10 * 60_000); // 12:10, after a gap
    const t5 = s.trade(coin.id, trader.id, "buy", 20).trade;

    const candles = s.getCandles(coin.id);
    assert.equal(candles.length, 4, "12:00, 12:01, 12:02 and 12:10 (no empty candles for the gap)");
    assert.deepEqual(
      candles.map((c) => c.t),
      [bucket0, bucket0 + 60_000, bucket0 + 120_000, bucket0 + 600_000],
    );

    const [c0, c1, c2, c3] = candles;
    // launch candle absorbs the first trade
    assert.equal(c0.o, launch);
    assert.equal(c0.c, t1.price);
    assert.equal(c0.h, Math.max(launch, t1.price));
    assert.equal(c0.l, launch);
    assert.equal(c0.v, 100);
    // next candle opens at the previous close
    assert.equal(c1.o, t1.price);
    assert.equal(c1.c, t2.price);
    assert.equal(c1.h, t2.price);
    assert.equal(c1.l, t1.price);
    assert.equal(c1.v, 300);
    // two trades in one bucket: sell then buy
    assert.equal(c2.o, t2.price);
    assert.equal(c2.c, t4.price);
    assert.equal(c2.h, t2.price, "opens at the high, the sell took it down");
    assert.equal(c2.l, t3.price);
    approx(c2.v, t3.usdc + 50);
    assert.ok(c2.l < c2.o && c2.c > c2.l);
    // after the gap
    assert.equal(c3.o, t4.price);
    assert.equal(c3.c, t5.price);
    assert.equal(c3.v, 20);
    for (const c of candles) assert.ok(c.l <= Math.min(c.o, c.c) && c.h >= Math.max(c.o, c.c), "OHLC consistency");

    // The coin detail carries the same candles; results are copies, the cache is untouched.
    assert.deepEqual(s.getCoinByCa(coin.ca)!.candles, candles);
    candles[0].v = 12345;
    assert.equal(s.getCandles(coin.id)[0].v, 100);

    // The last trade is also the coin's lastTrade and the change is measured against the launch price.
    const summary = s.getCoinByCa(coin.ca)!;
    assert.equal(summary.lastTrade?.id, t5.id);
    approx(summary.change24h, t5.price / launch - 1, 1e-12);
  });

  it("change24h uses the last price at or before 24h ago once the coin is old enough", (t) => {
    const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const trader = funded(s, "trader", 10_000);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    const old = s.trade(coin.id, trader.id, "buy", 500).trade; // day 0
    t.mock.timers.setTime(T0 + 36 * 3_600_000);
    const recent = s.trade(coin.id, trader.id, "buy", 100).trade; // 36h later
    t.mock.timers.setTime(T0 + 48 * 3_600_000); // now: 48h; cutoff 24h -> reference is `old`
    approx(s.getCoinByCa(coin.ca)!.change24h, recent.price / old.price - 1, 1e-12);
  });
});

// ---------------------------------------------------------------------------
// Lists, comments, wallet, profile
// ---------------------------------------------------------------------------

describe("lists and aggregates", () => {
  it("listCoins sorts, searches and filters by creator; getKing picks the top open coin", () => {
    const s = fresh();
    const a = funded(s, "alice", 10_000);
    const b = funded(s, "bob", 10_000);
    const c1 = s.createCoin(a, coinInput({ name: "Alpha Dog", ticker: "ALPHA" }), IMAGE).coin;
    const c2 = s.createCoin(b, coinInput({ name: "Beta Cat", ticker: "BETA" }), IMAGE).coin;
    const c3 = s.createCoin(a, coinInput({ name: "Gamma Frog", ticker: "GAMMA" }), IMAGE).coin;
    s.trade(c2.id, a.id, "buy", 500);
    s.trade(c1.id, b.id, "buy", 50);
    s.trade(c1.id, b.id, "buy", 50);

    assert.deepEqual(s.listCoins({ sort: "new" }).map((c) => c.id), [c3.id, c2.id, c1.id]);
    assert.deepEqual(s.listCoins({ sort: "mcap" }).map((c) => c.id), [c2.id, c1.id, c3.id]);
    assert.deepEqual(s.listCoins({ sort: "volume" }).map((c) => c.id), [c2.id, c1.id, c3.id]);
    assert.deepEqual(s.listCoins({ sort: "trending" }).map((c) => c.id), [c2.id, c1.id, c3.id]);
    assert.deepEqual(s.listCoins({ sort: "graduated" }), []);
    assert.deepEqual(s.listCoins({ search: "cat" }).map((c) => c.id), [c2.id]);
    assert.deepEqual(s.listCoins({ search: "GAMMA" }).map((c) => c.id), [c3.id]);
    assert.deepEqual(s.listCoins({ search: c1.ca }).map((c) => c.id), [c1.id]);
    assert.deepEqual(s.listCoins({ creatorId: a.id }).map((c) => c.id), [c3.id, c1.id]);
    assert.equal(s.listCoins({ limit: 2 }).length, 2);
    assert.equal(s.getKing()?.id, c2.id);
    assert.equal(fresh().getKing(), null);

    const profile = s.getPublicProfile("ALICE")!;
    assert.equal(profile.user.id, a.id);
    assert.deepEqual(profile.createdCoins.map((c) => c.id), [c3.id, c1.id]);
    assert.equal(profile.holdingsCount, 1);
    assert.equal(profile.joinedAt, a.createdAt);
    assert.equal(s.getPublicProfile("nobody"), undefined);
    assert.deepEqual(s.getPortfolio(a.id).createdCoins.map((c) => c.id), [c3.id, c1.id]);
  });

  it("comments carry the commenter's holding and toggle likes", () => {
    const s = fresh();
    const creator = funded(s, "creator", 0);
    const fan = funded(s, "fan", 100);
    const { coin } = s.createCoin(creator, coinInput(), IMAGE);
    s.trade(coin.id, fan.id, "buy", 25);
    const c = s.addComment(coin.id, fan.id, "  gm  ", "/uploads/comments/1.webp");
    assert.equal(c.body, "gm");
    assert.equal(c.imageUrl, "/uploads/comments/1.webp");
    assert.equal(c.user.username, "fan");
    assert.ok(c.holding > 0);
    assert.deepEqual(c.likes, []);
    const dev = s.addComment(coin.id, creator.id, "wagmi");
    assert.equal(dev.holding, 0);
    assert.equal(dev.imageUrl, null);
    assertHttp(() => s.addComment(coin.id, fan.id, "   "), 400);
    assertHttp(() => s.addComment(999, fan.id, "x"), 404);

    assert.deepEqual(s.toggleLike(c.id, creator.id).likes, [creator.id]);
    assert.deepEqual(s.toggleLike(c.id, fan.id).likes, [creator.id, fan.id]);
    assert.deepEqual(s.toggleLike(c.id, creator.id).likes, [fan.id]);
    assertHttp(() => s.toggleLike(999, fan.id), 404);
    assert.equal(s.getCommentCoinCa(c.id), coin.ca);

    const detail = s.getCoinByCa(coin.ca)!;
    assert.equal(detail.comments, 2);
    assert.deepEqual(detail.commentsList.map((x) => x.id), [dev.id, c.id], "newest first");
  });

  it("wallet: deposits are idempotent, withdrawals debit and refund on failure, faucet is rate limited", () => {
    const s = fresh();
    const u = funded(s, "wally", 0);
    assert.ok(s.recordDeposit(u.id, "0xABC:0", 12.5, 100));
    assert.equal(s.recordDeposit(u.id, "0xabc:0", 12.5, 100), null, "same tx hash is ignored");
    assert.equal(s.getUser(u.id)!.balance, 12.5);
    assert.deepEqual(s.listDepositAddresses(), [{ address: u.depositAddress, userId: u.id }]);

    assertHttp(() => s.requestWithdrawal(u.id, "0x" + "1".repeat(40), 0.5), 400, /Minimum/);
    assertHttp(() => s.requestWithdrawal(u.id, "0x" + "1".repeat(40), 50), 400, /Insufficient/);
    const w = s.requestWithdrawal(u.id, "0x" + "1".repeat(40), 10);
    assert.equal(s.getUser(u.id)!.balance, 2.5);
    assert.equal(s.getWithdrawal(w.id)?.status, "pending");
    assert.equal(s.listWithdrawals("pending").length, 1);
    s.updateWithdrawal(w.id, { status: "failed", error: "boom" });
    assert.equal(s.getUser(u.id)!.balance, 12.5, "failed withdrawal refunds");
    s.updateWithdrawal(w.id, { status: "failed" });
    assert.equal(s.getUser(u.id)!.balance, 12.5, "refund happens once");

    const wallet = s.getWallet(u.id);
    assert.equal(wallet.deposits.length, 1);
    assert.equal(wallet.withdrawals.length, 1);
    assert.equal(wallet.chain.testnet, true);

    s.faucet(u.id);
    assert.equal(s.getUser(u.id)!.balance, 1012.5);
    assertHttp(() => s.faucet(u.id), 429);

    assert.equal(s.getLastScannedBlock(), null);
    s.setLastScannedBlock(42);
    assert.equal(s.getLastScannedBlock(), 42);
    assert.equal(s.getOrCreateMnemonic(() => "a b c"), "a b c");
    assert.equal(s.getOrCreateMnemonic(() => "other"), "a b c");
  });
});

// ---------------------------------------------------------------------------
// Persistence round trip & seed
// ---------------------------------------------------------------------------

describe("seed and persistence", () => {
  it("initStorage seeds a fresh deployment deterministically and the snapshot restores", async (t) => {
    t.mock.method(console, "log", () => {}); // silence storage/seed logging
    fs.rmSync(dataFile, { force: true });
    const s = await initStorage({ deriveDepositAddress });
    const state = s.snapshot();

    assert.equal(state.coins.length, 14);
    assert.equal(state.users.length, 8, "eight bots");
    assert.ok(state.users.every((u) => u.depositIndex === -1 && u.depositAddress === "" && u.avatarUrl?.startsWith("data:image/svg+xml;base64,")));
    assert.ok(state.trades.length >= 14 * 25, `expected a rich history, got ${state.trades.length} trades`);
    assert.ok(state.comments.length >= 14 * 2);
    assert.ok(state.platformRevenue > 0);
    assert.equal(s.listUsers().length, 0, "bots are hidden from the admin list");

    const cas = new Set<string>();
    for (const coin of state.coins) {
      assert.ok(isValidCa(coin.ca));
      cas.add(coin.ca);
      assert.ok(coin.imageUrl.startsWith("data:image/svg+xml;base64,"));
      const trades = state.trades.filter((x) => x.coinId === coin.id);
      assert.ok(trades.length >= 20, `${coin.ticker} has only ${trades.length} trades`);
      for (let i = 1; i < trades.length; i++) assert.ok(Date.parse(trades[i].createdAt) >= Date.parse(trades[i - 1].createdAt), "chronological");
      assert.ok(Date.parse(trades[trades.length - 1].createdAt) <= Date.now());
      assert.ok(Date.parse(trades[0].createdAt) >= Date.parse(coin.createdAt));
      assert.ok(coin.curveTokens >= -1e-6 && coin.realUsdc >= -1e-6);
      approx(coin.circulating + coin.curveTokens, TOTAL_SUPPLY, 1e-3);
      const held = state.holdings.filter((h) => h.coinId === coin.id).reduce((sum, h) => sum + h.tokens, 0);
      approx(held, coin.circulating, 1e-3);
      const candles = s.getCandles(coin.id);
      assert.ok(candles.length >= 2);
      assert.equal(candles[0].t, Math.floor(Date.parse(coin.createdAt) / 60_000) * 60_000, "launch candle sits in the creation minute");
      for (let i = 1; i < candles.length; i++) assert.ok(candles[i].t > candles[i - 1].t);
      const detail = s.getCoinByCa(coin.ca)!;
      assert.ok(detail.holders >= 1 && detail.comments >= 2);
      assert.ok(detail.recentTrades.length > 0 && detail.recentTrades.length <= 200);
    }
    assert.equal(cas.size, 14, "CAs are unique");
    // Bots never went negative and the ledger is consistent for real users (none yet).
    assert.ok(state.users.every((u) => u.balance >= 0 && u.creatorEarnings >= 0));

    const king = s.getKing();
    assert.ok(king, "there is always a King");
    const graduated = s.listCoins({ sort: "graduated" });
    if (selloutMarketCap(0) >= GRADUATION_MCAP) {
      assert.equal(graduated.length, 1, "exactly one seeded coin is graduated");
      assert.ok(king.marketCap >= KING_MCAP, `King should be above KING_MCAP, got ${king.marketCap}`);
      assert.ok(!king.graduated);
    } else {
      assert.equal(graduated.length, 0, "the VIRTUAL_* constants make graduation unreachable");
    }
    assert.equal(s.listCoins({ sort: "mcap" })[0].marketCap >= king.marketCap, true);

    // The seed reaches disk and restores to the same numbers.
    await s.flush();
    const json = fs.readFileSync(dataFile, "utf8");
    const copy = fresh();
    copy.restore(json);
    const cs = copy.snapshot();
    assert.equal(cs.coins.length, 14);
    assert.equal(cs.trades.length, state.trades.length);
    assert.equal(cs.holdings.length, state.holdings.length);
    assert.equal(cs.platformRevenue, state.platformRevenue);
    assert.deepEqual(cs.ids, state.ids);
    for (const coin of state.coins) {
      assert.deepEqual(copy.getCandles(coin.id), s.getCandles(coin.id));
      assert.deepEqual(copy.getCoinByCa(coin.ca)!.topHolders, s.getCoinByCa(coin.ca)!.topHolders);
    }
    // New entities get ids above everything restored.
    const maxRestoredId = Math.max(...cs.users.map((x) => x.id));
    const u = copy.findOrCreateUser("new@example.com", "email");
    assert.ok(u.user.id > maxRestoredId);
    assert.equal(u.user.depositIndex, 0, "bots do not consume HD wallet indexes");
  });

  it("restore tolerates missing fields in old snapshots", () => {
    const s = fresh();
    s.restore(
      JSON.stringify({
        users: [{ id: 3, email: "old@example.com", username: "old" }],
        coins: [{ id: 7, ca: "x".repeat(39) + "noxia", name: "Old", ticker: "OLD", creatorId: 3, creatorAllocation: 0.2, createdAt: "2026-01-01T00:00:00.000Z" }],
        trades: [{ id: 2, coinId: 7, userId: 3, side: "buy", usdc: 10, tokens: 5, price: 0.000004, createdAt: "2026-01-01T00:01:00.000Z" }],
      }),
    );
    const state = s.snapshot();
    assert.equal(state.users[0].balance, 0);
    assert.equal(state.users[0].avatarUrl, null);
    assert.equal(state.users[0].walletAddress, null);
    assert.equal(state.users[0].creatorEarnings, 0);
    assert.equal(state.coins[0].graduated, false);
    approx(state.coins[0].curveTokens, TOTAL_SUPPLY * 0.8, 1e-3);
    approx(state.coins[0].circulating, TOTAL_SUPPLY * 0.2, 1e-3);
    assert.equal(state.trades[0].fee, 0);
    assert.equal(state.platformRevenue, 0);
    assert.deepEqual(state.ids, { user: 4, coin: 8, trade: 3, holding: 1, comment: 1, deposit: 1, withdrawal: 1 });
    const detail = s.getCoinByCa("x".repeat(39) + "noxia")!;
    assert.equal(detail.creator.username, "old");
    assert.equal(detail.candles.length, 2);
    assert.equal(detail.candles[1].c, 0.000004);
    assert.equal(detail.recentTrades.length, 1);
    assert.throws(() => fresh().restore("[]"));
  });
});
