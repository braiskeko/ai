import assert from "node:assert/strict";
import test from "node:test";
import BN from "bn.js";
import { TokenDecimal, getSqrtPriceFromPrice } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAMPORTS_PER_SOL, TOTAL_SUPPLY } from "@shared/schema";
import {
  baseUnitsToTokens,
  decodeMetaplexMetadata,
  explorerUrl,
  lamportsToSol,
  marketCapSol,
  priceFromSqrt,
  solToLamports,
  toTradeQuote,
  tokensToBaseUnits,
  type RawSwapQuote,
} from "./solana";

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------

test("lamports and SOL convert both ways", () => {
  assert.equal(lamportsToSol(new BN(LAMPORTS_PER_SOL)), 1);
  assert.equal(lamportsToSol(50_000_000), 0.05);
  assert.equal(lamportsToSol("0"), 0);
  assert.equal(solToLamports(1).toString(), String(LAMPORTS_PER_SOL));
  assert.equal(solToLamports(0.05).toString(), "50000000");
  assert.equal(solToLamports(0.000000001).toString(), "1");
  assert.equal(lamportsToSol(solToLamports(2.7431)), 2.7431);
});

test("SOL amounts that cannot be paid are clamped to zero lamports", () => {
  assert.equal(solToLamports(0).toString(), "0");
  assert.equal(solToLamports(-5).toString(), "0");
  assert.equal(solToLamports(Number.NaN).toString(), "0");
});

test("tokens and base units use 6 decimals and never round up", () => {
  assert.equal(tokensToBaseUnits(1).toString(), "1000000");
  assert.equal(tokensToBaseUnits(1_000_000_000).toString(), "1000000000000000");
  assert.equal(tokensToBaseUnits(0.0000019).toString(), "1", "a partial base unit is floored, never rounded up");
  assert.equal(baseUnitsToTokens(new BN("2500000")), 2.5);
  assert.equal(baseUnitsToTokens(tokensToBaseUnits(1234.5678)), 1234.5678);
});

test("big base-unit amounts survive the BN -> number conversion", () => {
  // The whole supply in base units (1e15) is beyond a u53 only after ~9e15.
  assert.equal(baseUnitsToTokens(new BN("1000000000000000")), TOTAL_SUPPLY);
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

test("priceFromSqrt inverts the SDK's price -> sqrtPrice conversion", () => {
  for (const price of ["0.000000032", "0.0000004", "0.0000069"]) {
    const sqrt = getSqrtPriceFromPrice(price, TokenDecimal.SIX, TokenDecimal.NINE);
    assert.ok(Math.abs(priceFromSqrt(sqrt) - Number(price)) < Number(price) * 1e-9, `round trip for ${price}`);
  }
});

test("market cap is the spot price times the whole supply", () => {
  assert.equal(marketCapSol(0.00000005), 0.00000005 * TOTAL_SUPPLY);
  assert.equal(marketCapSol(0), 0);
});

// ---------------------------------------------------------------------------
// Quote conversion (hand-built pool state, no RPC)
// ---------------------------------------------------------------------------

const sqrtAt = (price: string): BN => getSqrtPriceFromPrice(price, TokenDecimal.SIX, TokenDecimal.NINE);

/** A swap result as `dbc.pool.swapQuote` returns it. */
function rawQuote(over: Partial<RawSwapQuote> & Pick<RawSwapQuote, "outputAmount" | "nextSqrtPrice">): RawSwapQuote {
  return {
    actualInputAmount: new BN(0),
    tradingFee: new BN(0),
    protocolFee: new BN(0),
    referralFee: new BN(0),
    minimumAmountOut: over.outputAmount,
    ...over,
  };
}

test("a buy quote converts lamports in and base units out", () => {
  const amountIn = solToLamports(1); // 1 SOL
  const result = rawQuote({
    actualInputAmount: amountIn,
    outputAmount: new BN("20000000000"), // 20,000 tokens
    minimumAmountOut: new BN("19000000000"), // 5% slippage
    nextSqrtPrice: sqrtAt("0.00000006"),
    // 2.7% of 1 SOL, split the way the program splits it
    tradingFee: new BN("24300000"),
    protocolFee: new BN("2700000"),
    referralFee: new BN("0"),
  });

  const quote = toTradeQuote({
    side: "buy",
    amountIn,
    result,
    sqrtPriceBefore: sqrtAt("0.00000005"),
    quoteReserve: new BN("10000000000"), // 10 SOL in the curve
    migrationQuoteThreshold: new BN("85000000000"), // 85 SOL completes it
  });

  assert.equal(quote.side, "buy");
  assert.equal(quote.amountIn, 1, "amountIn is SOL");
  assert.equal(quote.amountOut, 20_000, "amountOut is whole tokens");
  assert.equal(quote.minOut, 19_000);
  assert.ok(Math.abs(quote.feeSol - 0.027) < 1e-12, "the three fee buckets add up to 2.7%");
  assert.ok(Math.abs(quote.priceBeforeSol - 0.00000005) < 1e-15);
  assert.ok(Math.abs(quote.priceAfterSol - 0.00000006) < 1e-15);
  assert.ok(Math.abs(quote.priceImpact - 0.2) < 1e-9, "price moved 20%");
  assert.ok(Math.abs(quote.marketCapAfterSol - 60) < 1e-6, "0.00000006 SOL x 1e9 supply");
  assert.equal(quote.completesCurve, false);
});

test("a sell quote converts base units in and lamports out", () => {
  const amountIn = tokensToBaseUnits(20_000);
  const result = rawQuote({
    actualInputAmount: amountIn,
    outputAmount: solToLamports(0.9), // 0.9 SOL back
    minimumAmountOut: solToLamports(0.855),
    nextSqrtPrice: sqrtAt("0.00000004"),
    tradingFee: new BN("22000000"),
    protocolFee: new BN("2000000"),
    referralFee: new BN("0"),
  });

  const quote = toTradeQuote({
    side: "sell",
    amountIn,
    result,
    sqrtPriceBefore: sqrtAt("0.00000005"),
    quoteReserve: new BN("10000000000"),
    migrationQuoteThreshold: new BN("85000000000"),
  });

  assert.equal(quote.side, "sell");
  assert.equal(quote.amountIn, 20_000, "amountIn is whole tokens");
  assert.equal(quote.amountOut, 0.9, "amountOut is SOL");
  assert.equal(quote.minOut, 0.855);
  assert.ok(Math.abs(quote.feeSol - 0.024) < 1e-12);
  assert.ok(quote.priceImpact < 0, "selling pushes the price down");
  assert.equal(quote.completesCurve, false);
});

test("a buy that reaches the migration threshold completes the curve", () => {
  const amountIn = solToLamports(80);
  const quote = toTradeQuote({
    side: "buy",
    amountIn,
    result: rawQuote({
      actualInputAmount: amountIn,
      outputAmount: new BN("100000000000"),
      nextSqrtPrice: sqrtAt("0.0000002"),
    }),
    sqrtPriceBefore: sqrtAt("0.0000001"),
    quoteReserve: solToLamports(10),
    migrationQuoteThreshold: solToLamports(85),
  });
  assert.equal(quote.completesCurve, true, "10 + 80 SOL is past the 85 SOL threshold");
});

test("a zero price before a trade does not produce NaN impact", () => {
  const quote = toTradeQuote({
    side: "buy",
    amountIn: solToLamports(1),
    result: rawQuote({ outputAmount: new BN("1000000"), nextSqrtPrice: sqrtAt("0.00000001") }),
    sqrtPriceBefore: new BN(0),
    quoteReserve: new BN(0),
    migrationQuoteThreshold: solToLamports(85),
  });
  assert.equal(quote.priceBeforeSol, 0);
  assert.equal(quote.priceImpact, 0);
});

// ---------------------------------------------------------------------------
// Metaplex metadata
// ---------------------------------------------------------------------------

/** Builds a Metaplex `Metadata` account body: key, authority, mint, then 3 strings. */
function metadataAccount(name: string, symbol: string, uri: string, pad = { name: 32, symbol: 10, uri: 200 }): Uint8Array {
  const encoder = new TextEncoder();
  const strings = [
    { value: name, size: pad.name },
    { value: symbol, size: pad.symbol },
    { value: uri, size: pad.uri },
  ];
  const total = 1 + 32 + 32 + strings.reduce((sum, s) => sum + 4 + s.size, 0);
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  buffer[0] = 4; // Key::MetadataV1
  let offset = 1 + 32 + 32;
  for (const { value, size } of strings) {
    view.setUint32(offset, size, true);
    offset += 4;
    // The program right-pads the fixed-size strings with NUL bytes.
    buffer.set(encoder.encode(value).slice(0, size), offset);
    offset += size;
  }
  return buffer;
}

test("Metaplex metadata decodes to name, symbol and uri", () => {
  const uri = "https://app.noxia.work/api/meta/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU.json";
  const decoded = decodeMetaplexMetadata(metadataAccount("Next Cat", "NCAT", uri));
  assert.deepEqual(decoded, { name: "Next Cat", symbol: "NCAT", uri });
});

test("NUL padding and surrounding whitespace are trimmed", () => {
  const decoded = decodeMetaplexMetadata(metadataAccount("  Spaced  ", "PAD", "https://x.test/m.json"));
  assert.equal(decoded?.name, "Spaced");
  assert.equal(decoded?.symbol, "PAD");
});

test("unicode names survive the decode", () => {
  const decoded = decodeMetaplexMetadata(metadataAccount("Köpke 🐸", "FROG", "https://x.test/m.json"));
  assert.equal(decoded?.name, "Köpke 🐸");
});

test("buffers that are not metadata decode to null", () => {
  assert.equal(decodeMetaplexMetadata(new Uint8Array(10)), null, "too short");
  assert.equal(decodeMetaplexMetadata(new Uint8Array(0)), null);

  // A plausible header followed by an absurd string length.
  const broken = new Uint8Array(1 + 32 + 32 + 12);
  new DataView(broken.buffer).setUint32(65, 0xffffff, true);
  assert.equal(decodeMetaplexMetadata(broken), null);

  // Truncated in the middle of the uri.
  const full = metadataAccount("Name", "SYM", "https://x.test/m.json");
  assert.equal(decodeMetaplexMetadata(full.slice(0, full.length - 50)), null);
});

// ---------------------------------------------------------------------------
// Explorer links
// ---------------------------------------------------------------------------

test("explorer links point at solscan and carry the cluster off mainnet", () => {
  const url = explorerUrl("tx", "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7");
  assert.ok(url.startsWith("https://solscan.io/tx/"));
  // The tests run on the default cluster (devnet).
  assert.ok(url.includes("?cluster=devnet"));
  assert.ok(explorerUrl("token", "mint").startsWith("https://solscan.io/token/"));
  assert.ok(explorerUrl("account", "acct").startsWith("https://solscan.io/account/"));
});
