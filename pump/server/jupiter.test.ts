import assert from "node:assert/strict";
import test from "node:test";

/**
 * Pure units only — this sandbox (and CI) cannot reach jup.ag, so nothing here
 * performs a network call. The payloads below are hand-written to match the
 * shapes documented for Jupiter's tokens/v2 and swap/v1 endpoints, including
 * the awkward parts we code defensively against: numbers arriving as strings,
 * missing blocks, and entries that are outright malformed.
 */
import {
  asArray,
  candlesFor,
  clearPriceHistory,
  derivePriceCandles,
  fromBaseUnits,
  parseJupQuote,
  parseJupToken,
  parseJupTokens,
  priceHistory,
  recordPrice,
  toBaseUnits,
  toExternalTradeQuote,
  PRICE_BUFFER_CAP,
  type JupQuote,
} from "./jupiter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

/** One entry as the toporganicscore/toptraded/recent lists return it. */
const SAMPLE = {
  id: BONK,
  name: "Bonk",
  symbol: "bonk",
  icon: "https://cdn.test/bonk.png",
  decimals: 5,
  usdPrice: 0.00002341,
  mcap: 1_820_000_000,
  fdv: 2_100_000_000,
  liquidity: 12_500_000,
  holderCount: 942_101,
  organicScore: 87.4,
  isVerified: true,
  stats24h: { priceChange: 12.5, buyVolume: 4_000_000, sellVolume: 3_500_000, numBuys: 41_000, numSells: 39_000 },
  firstPool: { id: "8Pp...pool", dex: "raydium", createdAt: "2023-12-25T10:00:00Z" },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 21.5 },
  // Fields we do not model must be stripped rather than rejected.
  tags: ["verified"],
  ctLikes: 12,
};

test("a well-formed token maps to ExternalToken + extras", () => {
  const parsed = parseJupToken(SAMPLE);
  assert.ok(parsed);
  const { token, extras } = parsed;

  assert.equal(token.mint, BONK);
  assert.equal(token.name, "Bonk");
  assert.equal(token.symbol, "BONK", "symbols are upper-cased for the $TICKER display");
  assert.equal(token.decimals, 5);
  assert.equal(token.priceUsd, 0.00002341);
  assert.equal(token.marketCapUsd, 1_820_000_000, "mcap wins over fdv");
  assert.equal(token.liquidityUsd, 12_500_000);
  assert.equal(token.change24h, 0.125, "percent from Jupiter becomes a fraction");
  assert.equal(token.volume24hUsd, 7_500_000, "24h volume is buy + sell");
  assert.equal(token.holders, 942_101);
  assert.equal(token.verified, true);
  assert.equal(token.createdAt, "2023-12-25T10:00:00.000Z");
  assert.equal(token.source, "jupiter");

  assert.equal(extras.buys24h, 41_000);
  assert.equal(extras.sells24h, 39_000);
  assert.equal(extras.audit.mintAuthorityDisabled, true);
  assert.equal(extras.audit.topHoldersPercent, 0.215, "top-holder percent becomes a fraction");
  assert.equal(extras.pool?.dex, "raydium");
  // supply = mcap / price, so the market cap after a trade can be recomputed.
  assert.ok(Math.abs(extras.supply - 1_820_000_000 / 0.00002341) < 1);
  assert.equal(Object.prototype.hasOwnProperty.call(token, "tags"), false, "unknown keys are stripped");
});

test("string numbers, missing blocks and odd values degrade per field", () => {
  const parsed = parseJupToken({
    id: WIF,
    symbol: "wif",
    usdPrice: "1.85",
    mcap: "1850000000",
    liquidity: "not a number",
    holderCount: 200_000.7,
    isVerified: "yes",
    stats24h: { priceChange: "-4.2" },
    firstPool: { createdAt: "nonsense" },
  });
  assert.ok(parsed);
  const { token, extras } = parsed;

  assert.equal(token.priceUsd, 1.85, "numeric strings are accepted");
  assert.equal(token.marketCapUsd, 1_850_000_000);
  assert.equal(token.liquidityUsd, 0, "an unparseable number degrades to 0, it does not drop the token");
  assert.equal(token.holders, 200_001, "holder counts are rounded to integers");
  assert.equal(token.verified, false, "only a real boolean means verified");
  assert.equal(token.change24h, -0.042);
  assert.equal(token.name, "wif", "the symbol stands in for a missing name");
  assert.equal(token.decimals, 6, "decimals default to 6 when absent");
  assert.equal(token.createdAt, null, "an unparseable date becomes null");
  assert.equal(token.volume24hUsd, 0);
  assert.equal(extras.audit.mintAuthorityDisabled, null, "unknown audit flags stay unknown, never false");
  assert.equal(extras.audit.topHoldersPercent, null);
  assert.equal(extras.pool?.dex, null);
});

test("malformed entries are skipped, not fatal", () => {
  assert.equal(parseJupToken(null), null);
  assert.equal(parseJupToken({}), null, "an entry with no mint is unusable");
  assert.equal(parseJupToken({ id: "short" }), null, "an id that cannot be a mint is unusable");

  const tokens = parseJupTokens([SAMPLE, { id: "nope" }, null, { ...SAMPLE }, { id: WIF, symbol: "wif" }]);
  assert.deepEqual(
    tokens.map((t) => t.mint),
    [BONK, WIF],
    "duplicates and junk are dropped, order is preserved",
  );
});

test("the list is found whichever envelope it arrives in", () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray({ tokens: [1] }), [1]);
  assert.deepEqual(asArray({ data: [2] }), [2]);
  assert.deepEqual(asArray({ nothing: true }), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(parseJupTokens({ tokens: [SAMPLE] }).map((t) => t.mint), [BONK]);
});

test("parseJupTokens honours the limit", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...SAMPLE, id: `${BONK.slice(0, 43)}${i}` }));
  assert.equal(parseJupTokens(many, 3).length, 3);
});

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------

test("whole amounts convert to exact integer base units", () => {
  assert.equal(toBaseUnits(0.1, 9), "100000000", "0.1 SOL is exactly 1e8 lamports, no float dust");
  assert.equal(toBaseUnits(1, 9), "1000000000");
  assert.equal(toBaseUnits(1.005, 9), "1005000000");
  assert.equal(toBaseUnits(1234.56789, 6), "1234567890");
  assert.equal(toBaseUnits(0.0000001, 5), "0", "amounts below one base unit floor to zero");
  assert.equal(toBaseUnits(0, 9), "0");
  assert.equal(toBaseUnits(-5, 9), "0");
  assert.equal(toBaseUnits(Number.NaN, 9), "0");
  assert.equal(toBaseUnits(2, 0), "2");
});

test("base units convert back to whole amounts", () => {
  assert.equal(fromBaseUnits("100000000", 9), 0.1);
  assert.equal(fromBaseUnits(1_000_000, 6), 1);
  assert.equal(fromBaseUnits("junk", 6), 0);
  assert.equal(fromBaseUnits(0, 9), 0);
});

test("a SOL amount survives the round trip", () => {
  for (const sol of [0.001, 0.1, 0.5, 1, 12.345]) {
    assert.equal(fromBaseUnits(toBaseUnits(sol, 9), 9), sol);
  }
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** A buy: 0.5 SOL in, 21_000 BONK (5 dp) out, 1% slippage floor. */
const BUY_RESPONSE = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: BONK,
  inAmount: "500000000",
  outAmount: "2100000000",
  otherAmountThreshold: "2079000000",
  priceImpactPct: "0.0042",
  slippageBps: 100,
  platformFee: null,
  routePlan: [{ swapInfo: { label: "Meteora" }, percent: 100 }],
};

test("a quote response is shaped, keeping the raw body for the swap call", () => {
  const quote = parseJupQuote(BUY_RESPONSE);
  assert.ok(quote);
  assert.equal(quote.inAmount, 500_000_000);
  assert.equal(quote.outAmount, 2_100_000_000);
  assert.equal(quote.minOutAmount, 2_079_000_000);
  assert.equal(quote.priceImpact, 0.0042);
  assert.equal(quote.platformFeeAmount, 0);
  assert.equal(quote.raw, BUY_RESPONSE, "the swap endpoint needs its own object back verbatim");
});

test("an empty or routeless quote is rejected", () => {
  assert.equal(parseJupQuote(null), null);
  assert.equal(parseJupQuote({ inputMint: "a", outputMint: "b", inAmount: "1", outAmount: "0" }), null);
  assert.equal(parseJupQuote({ error: "no route" }), null);
});

test("a buy quote becomes a TradeQuote in SOL / token terms", () => {
  const route = parseJupQuote(BUY_RESPONSE)!;
  const quote = toExternalTradeQuote({
    side: "buy",
    quote: route,
    decimals: 5,
    priceUsd: 0.00002341,
    supply: 100_000_000_000,
    solUsd: 150,
  });

  assert.equal(quote.side, "buy");
  assert.equal(quote.amountIn, 0.5, "buys spend SOL");
  assert.equal(quote.amountOut, 21_000, "and receive whole tokens");
  assert.equal(quote.minOut, 20_790);
  assert.equal(quote.feeSol, 0, "no platform fee without a fee account");
  assert.equal(quote.priceImpact, 0.0042);
  // effective price = 0.5 SOL / 21000 tokens
  assert.ok(Math.abs(quote.priceAfterSol - 0.5 / 21_000) < 1e-15);
  assert.ok(Math.abs(quote.priceBeforeSol - 0.00002341 / 150) < 1e-15, "spot price converted through solUsd");
  assert.ok(Math.abs(quote.marketCapAfterSol - 100_000_000_000 * (0.5 / 21_000)) < 1e-6);
  assert.equal(quote.completesCurve, false, "external tokens have no curve to complete");
});

test("a sell quote flips the sides and reads the fee in SOL", () => {
  const route = parseJupQuote({
    inputMint: BONK,
    outputMint: "So11111111111111111111111111111111111111112",
    inAmount: "2100000000",
    outAmount: "495000000",
    otherAmountThreshold: "490050000",
    priceImpactPct: 0.001,
    // 1% platform fee, charged on the output mint (SOL on a sell)
    platformFee: { amount: "5000000", feeBps: 100 },
  })!;

  const quote = toExternalTradeQuote({
    side: "sell",
    quote: route,
    decimals: 5,
    priceUsd: 0.00002341,
    supply: 0,
    solUsd: 150,
  });

  assert.equal(quote.side, "sell");
  assert.equal(quote.amountIn, 21_000, "sells spend whole tokens");
  assert.equal(quote.amountOut, 0.495, "and receive SOL");
  assert.equal(quote.minOut, 0.49005);
  assert.equal(quote.feeSol, 0.005, "the SOL-side fee converts straight from lamports");
  assert.equal(quote.marketCapAfterSol, 0, "an unknown supply reports no market cap");
});

test("a buy-side platform fee is converted from tokens into SOL", () => {
  const route = parseJupQuote({
    ...BUY_RESPONSE,
    platformFee: { amount: "21000000", feeBps: 100 },
  })!;
  const quote = toExternalTradeQuote({
    side: "buy",
    quote: route,
    decimals: 5,
    priceUsd: 0.00002341,
    supply: 0,
    solUsd: 150,
  });
  // 210 tokens of fee at the route's effective price (0.5 SOL / 21000 tokens).
  assert.ok(Math.abs(quote.feeSol - 210 * (0.5 / 21_000)) < 1e-12);
});

test("a quote with a zero output cannot produce a price", () => {
  const route: JupQuote = {
    raw: {},
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: BONK,
    inAmount: 1_000_000,
    outAmount: 0,
    minOutAmount: 0,
    platformFeeAmount: 0,
    priceImpact: 0,
  };
  const quote = toExternalTradeQuote({ side: "buy", quote: route, decimals: 5, priceUsd: 0, supply: 0, solUsd: 150 });
  assert.equal(quote.priceAfterSol, 0);
  assert.equal(quote.marketCapAfterSol, 0);
  assert.ok(Number.isFinite(quote.priceBeforeSol));
});

// ---------------------------------------------------------------------------
// Price buffer → candles
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

test("samples in the same minute collapse into one OHLC candle", () => {
  const t0 = 1_700_000_040_000; // 40 s into a minute
  const bucket = Math.floor(t0 / MINUTE) * MINUTE;
  const candles = derivePriceCandles([
    { t: t0, price: 1 },
    { t: t0 + 5_000, price: 3 },
    { t: t0 + 10_000, price: 0.5 },
    { t: t0 + 15_000, price: 2 },
  ]);

  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0], { t: bucket, o: 1, h: 3, l: 0.5, c: 2, v: 0 });
});

test("candles are bucketed per minute, ordered, and gaps are simply absent", () => {
  const t0 = Math.floor(1_700_000_000_000 / MINUTE) * MINUTE;
  const candles = derivePriceCandles([
    { t: t0 + 3 * MINUTE, price: 4 },
    { t: t0, price: 1 },
    { t: t0 + 30_000, price: 2 },
    { t: t0 + MINUTE, price: 3 },
  ]);

  assert.deepEqual(
    candles.map((c) => [c.t - t0, c.o, c.c]),
    [
      [0, 1, 2],
      [MINUTE, 3, 3],
      [3 * MINUTE, 4, 4],
    ],
    "out-of-order samples are sorted; the empty 2nd minute is left to the chart to fill",
  );
});

test("non-positive and non-finite samples are ignored", () => {
  const t0 = 1_700_000_000_000;
  assert.deepEqual(derivePriceCandles([]), []);
  assert.deepEqual(
    derivePriceCandles([
      { t: t0, price: 0 },
      { t: t0, price: -1 },
      { t: Number.NaN, price: 5 },
      { t: t0, price: Number.POSITIVE_INFINITY },
    ]),
    [],
  );
});

test("the ring buffer records, de-bounces and caps", () => {
  clearPriceHistory();
  const t0 = 1_700_000_000_000;

  recordPrice(BONK, 1, t0);
  recordPrice(BONK, 2, t0 + 500); // same second: replaces rather than appends
  assert.deepEqual(priceHistory(BONK), [{ t: t0, price: 2 }]);

  recordPrice(BONK, 3, t0 + 2_000);
  assert.equal(priceHistory(BONK).length, 2);

  recordPrice(BONK, 0, t0 + 4_000);
  recordPrice(BONK, Number.NaN, t0 + 6_000);
  assert.equal(priceHistory(BONK).length, 2, "unusable prices are never recorded");

  for (let i = 0; i < PRICE_BUFFER_CAP + 50; i++) recordPrice(BONK, i + 1, t0 + (i + 10) * 2_000);
  const points = priceHistory(BONK);
  assert.equal(points.length, PRICE_BUFFER_CAP, "the buffer is capped");
  assert.equal(points[points.length - 1].price, PRICE_BUFFER_CAP + 50, "the newest sample survives");

  assert.deepEqual(priceHistory("unknown-mint"), []);
  assert.deepEqual(candlesFor("unknown-mint"), [], "a mint nobody has viewed simply has no chart yet");
  clearPriceHistory();
});

test("candlesFor derives the chart from what was recorded", () => {
  clearPriceHistory();
  const t0 = 1_700_000_000_000;
  recordPrice(WIF, 1.8, t0);
  recordPrice(WIF, 1.9, t0 + 30_000);
  recordPrice(WIF, 1.7, t0 + 70_000);

  const candles = candlesFor(WIF);
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], { t: Math.floor(t0 / MINUTE) * MINUTE, o: 1.8, h: 1.9, l: 1.8, c: 1.9, v: 0 });
  assert.equal(candles[1].c, 1.7);
  clearPriceHistory();
});
