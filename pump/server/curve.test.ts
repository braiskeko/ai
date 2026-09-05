import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREATOR_FEE_SHARE,
  MAX_CREATOR_ALLOCATION,
  SWAP_FEE,
  TOTAL_SUPPLY,
  VIRTUAL_TOKEN_RESERVE,
  VIRTUAL_USDC_RESERVE,
} from "../shared/schema";
import { initialCurve, marketCap, quoteBuy, quoteSell, spotPrice, usdcForTokens, type CurveState } from "./curve";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so a failing run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertRelApprox(actual: number, expected: number, relTol: number, label: string) {
  const tol = relTol * Math.max(1e-300, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${actual} ≈ ${expected} (|diff| ${Math.abs(actual - expected)} > ${tol})`,
  );
}

/** Applies `n` buys of `usdc` each and returns the resulting state. */
function afterBuys(s: CurveState, n: number, usdc: number): CurveState {
  for (let i = 0; i < n; i++) s = quoteBuy(s, usdc).next;
  return s;
}

/** A curve state somewhere along its life: random allocation, then some random buying. */
function randomState(rand: () => number): CurveState {
  let s = initialCurve(rand() * MAX_CREATOR_ALLOCATION);
  const buys = Math.floor(rand() * 6);
  for (let i = 0; i < buys; i++) s = quoteBuy(s, 1 + rand() * 500).next;
  return s;
}

const ALLOCATIONS = [0, 0.05, 0.1, 0.2, MAX_CREATOR_ALLOCATION];

// ---------------------------------------------------------------------------
// initialCurve / spotPrice / marketCap
// ---------------------------------------------------------------------------

describe("initialCurve", () => {
  it("puts everything but the creator allocation up for sale, with no real USDC", () => {
    for (const a of ALLOCATIONS) {
      const s = initialCurve(a);
      assert.equal(s.realUsdc, 0);
      assertRelApprox(s.curveTokens, TOTAL_SUPPLY * (1 - a), 1e-12, `curveTokens for allocation ${a}`);
      assert.ok(s.curveTokens <= TOTAL_SUPPLY);
    }
  });

  it("a larger allocation means fewer tokens in the curve and a higher launch price", () => {
    let prevTokens = Infinity;
    let prevPrice = 0;
    for (const a of ALLOCATIONS) {
      const s = initialCurve(a);
      assert.ok(s.curveTokens < prevTokens || a === 0);
      assert.ok(spotPrice(s) > prevPrice);
      prevTokens = s.curveTokens;
      prevPrice = spotPrice(s);
    }
  });

  it("launch price follows from the virtual reserves", () => {
    const s = initialCurve(0);
    assertRelApprox(spotPrice(s), VIRTUAL_USDC_RESERVE / (TOTAL_SUPPLY + VIRTUAL_TOKEN_RESERVE), 1e-12, "launch price");
    assertRelApprox(marketCap(s), spotPrice(s) * TOTAL_SUPPLY, 1e-12, "launch market cap");
  });
});

describe("spotPrice / marketCap", () => {
  it("prices are positive and finite along the whole curve", () => {
    const rand = rng(1);
    for (let i = 0; i < 200; i++) {
      const s = randomState(rand);
      const p = spotPrice(s);
      assert.ok(Number.isFinite(p) && p > 0, `price ${p} for ${JSON.stringify(s)}`);
      assert.ok(Number.isFinite(marketCap(s)) && marketCap(s) > 0);
    }
  });

  it("marketCap is spotPrice × TOTAL_SUPPLY", () => {
    const rand = rng(2);
    for (let i = 0; i < 50; i++) {
      const s = randomState(rand);
      assertRelApprox(marketCap(s), spotPrice(s) * TOTAL_SUPPLY, 1e-12, "marketCap");
    }
  });

  it("every buy raises the price and every sell lowers it", () => {
    let s = initialCurve(0.05);
    let price = spotPrice(s);
    const bought: number[] = [];
    for (let i = 0; i < 25; i++) {
      const q = quoteBuy(s, 50 + i * 10);
      assert.ok(q.priceAfter > price, `buy ${i} should raise the price (${q.priceAfter} > ${price})`);
      assert.equal(q.priceBefore, price);
      assertRelApprox(spotPrice(q.next), q.priceAfter, 1e-12, "priceAfter equals spot price of next state");
      assert.ok(q.priceImpact > 0);
      s = q.next;
      price = q.priceAfter;
      bought.push(q.amountOut);
    }
    for (const tokens of bought.reverse()) {
      const q = quoteSell(s, tokens);
      assert.ok(q.priceAfter < price, "sell should lower the price");
      assert.ok(q.priceImpact < 0);
      s = q.next;
      price = q.priceAfter;
    }
  });
});

// ---------------------------------------------------------------------------
// quoteBuy
// ---------------------------------------------------------------------------

describe("quoteBuy", () => {
  it("rejects non-positive amounts", () => {
    const s = initialCurve(0);
    assert.throws(() => quoteBuy(s, 0));
    assert.throws(() => quoteBuy(s, -5));
    assert.throws(() => quoteBuy(s, Number.NaN));
  });

  it("charges SWAP_FEE on the amount in and splits it between creator and platform", () => {
    const rand = rng(3);
    for (let i = 0; i < 100; i++) {
      const s = randomState(rand);
      const usdc = Math.round((0.01 + rand() * 2000) * 100) / 100;
      const q = quoteBuy(s, usdc);
      assert.equal(q.amountIn, usdc);
      assertRelApprox(q.fee, usdc * SWAP_FEE, 1e-4, "fee");
      assert.ok(Math.abs(q.creatorFee + q.platformFee - q.fee) < 1e-9, "fee split sums to the fee");
      assertRelApprox(q.creatorFee, q.fee * CREATOR_FEE_SHARE, 1e-3, "creator share");
      assert.ok(q.platformFee >= q.creatorFee, "platform gets the larger share");
      // only the net amount enters the curve
      assertRelApprox(q.next.realUsdc, s.realUsdc + usdc - q.fee, 1e-9, "realUsdc after buy");
    }
  });

  it("never releases more tokens than the curve holds, even for absurd amounts", () => {
    for (const a of ALLOCATIONS) {
      const s = initialCurve(a);
      for (const usdc of [1, 1000, 1e6, 1e9, 1e12]) {
        const q = quoteBuy(s, usdc);
        assert.ok(q.amountOut <= s.curveTokens + 1e-9, `amountOut ${q.amountOut} > curveTokens ${s.curveTokens} for ${usdc} USDC`);
        assert.ok(q.amountOut > 0);
        assert.ok(q.next.curveTokens >= -1e-9, "curve never goes negative");
      }
    }
    // A sequence of large buys empties the curve and then yields nothing more.
    let s = initialCurve(0);
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const q = quoteBuy(s, 1e6);
      total += q.amountOut;
      s = q.next;
    }
    assertRelApprox(total, TOTAL_SUPPLY, 1e-9, "everything sold");
    assert.equal(quoteBuy(s, 100).amountOut, 0);
  });

  it("keeps the constant-product invariant while tokens remain", () => {
    const rand = rng(4);
    for (let i = 0; i < 100; i++) {
      const s = randomState(rand);
      const k = (s.realUsdc + VIRTUAL_USDC_RESERVE) * (s.curveTokens + VIRTUAL_TOKEN_RESERVE);
      const q = quoteBuy(s, 1 + rand() * 300);
      if (q.amountOut >= s.curveTokens) continue; // capped: invariant intentionally broken
      const k2 = (q.next.realUsdc + VIRTUAL_USDC_RESERVE) * (q.next.curveTokens + VIRTUAL_TOKEN_RESERVE);
      assertRelApprox(k2, k, 1e-6, "invariant");
    }
  });
});

// ---------------------------------------------------------------------------
// quoteSell & round trips
// ---------------------------------------------------------------------------

describe("quoteSell", () => {
  it("rejects non-positive amounts", () => {
    const s = afterBuys(initialCurve(0), 1, 100);
    assert.throws(() => quoteSell(s, 0));
    assert.throws(() => quoteSell(s, -1));
  });

  it("buy then sell the same tokens returns less USDC than paid (fees) and never more than the curve holds", () => {
    const rand = rng(5);
    for (let i = 0; i < 200; i++) {
      const s0 = randomState(rand);
      const usdc = 1 + rand() * 1000;
      const buy = quoteBuy(s0, usdc);
      if (buy.amountOut >= s0.curveTokens) continue; // sold out: not a fair round trip
      const sell = quoteSell(buy.next, buy.amountOut);
      assert.ok(sell.amountOut < usdc, `round trip ${sell.amountOut} should be below ${usdc}`);
      assert.ok(sell.amountOut <= buy.next.realUsdc + 1e-9, "cannot pay out more than the curve holds");
      // Both fees taken: the loss is at least the two 2.7% cuts.
      assert.ok(sell.amountOut <= usdc * (1 - SWAP_FEE) * (1 - SWAP_FEE) + 1e-5); // fee and payout are round6'd
      // Tokens go back where they came from.
      assertRelApprox(sell.next.curveTokens, s0.curveTokens, 1e-9, "curve tokens restored");
      // round6 is applied to fee and reserve updates, so allow a few micro-USDC of drift.
      assert.ok(Math.abs(sell.next.realUsdc - s0.realUsdc) <= 1e-5 + 1e-6 * s0.realUsdc, `real USDC restored (${sell.next.realUsdc} vs ${s0.realUsdc})`);
      assert.ok(Math.abs(sell.creatorFee + sell.platformFee - sell.fee) < 1e-9, "fee split sums to the fee");
    }
  });

  it("caps the payout at the USDC actually held by the curve", () => {
    // Creator allocation tokens never came from the curve: dumping them into an
    // almost empty curve can only extract what is there.
    const s = afterBuys(initialCurve(MAX_CREATOR_ALLOCATION), 1, 10);
    const q = quoteSell(s, TOTAL_SUPPLY * MAX_CREATOR_ALLOCATION);
    assert.ok(q.amountOut <= s.realUsdc, "net payout within the curve's USDC");
    assertRelApprox(q.amountOut + q.fee, s.realUsdc, 1e-6, "gross payout equals everything the curve holds");
    assert.ok(q.next.realUsdc >= 0);
  });

  it("selling everything that was bought empties the real reserve", () => {
    let s = initialCurve(0.1);
    const lots: number[] = [];
    for (let i = 0; i < 10; i++) {
      const q = quoteBuy(s, 25 * (i + 1));
      lots.push(q.amountOut);
      s = q.next;
    }
    for (const tokens of lots) s = quoteSell(s, tokens).next;
    assert.ok(Math.abs(s.realUsdc) < 1e-3, `realUsdc should be back near zero, got ${s.realUsdc}`);
    assertRelApprox(s.curveTokens, TOTAL_SUPPLY * 0.9, 1e-9, "curve tokens restored");
  });
});

// ---------------------------------------------------------------------------
// usdcForTokens
// ---------------------------------------------------------------------------

describe("usdcForTokens", () => {
  it("inverts quoteBuy within 1e-6 relative (USDC -> tokens -> USDC)", () => {
    const rand = rng(6);
    for (let i = 0; i < 300; i++) {
      const s = randomState(rand);
      const usdc = 1 + rand() * 2000;
      const q = quoteBuy(s, usdc);
      if (q.amountOut >= s.curveTokens) continue;
      assertRelApprox(usdcForTokens(s, q.amountOut), usdc, 1e-6, "usdcForTokens(quoteBuy(usdc).amountOut)");
    }
  });

  it("inverts quoteBuy within 1e-6 relative (tokens -> USDC -> tokens)", () => {
    const rand = rng(7);
    for (let i = 0; i < 300; i++) {
      const s = randomState(rand);
      const tokens = s.curveTokens * (0.0001 + rand() * 0.5);
      const usdc = usdcForTokens(s, tokens);
      assert.ok(usdc > 0);
      assertRelApprox(quoteBuy(s, usdc).amountOut, tokens, 1e-6, "quoteBuy(usdcForTokens(tokens)).amountOut");
    }
  });

  it("prices the whole remaining curve, so a buy of that size sells it out exactly", () => {
    for (const a of ALLOCATIONS) {
      const s = afterBuys(initialCurve(a), 3, 200);
      const all = usdcForTokens(s, s.curveTokens);
      assert.ok(Number.isFinite(all) && all > 0);
      const q = quoteBuy(s, all);
      assertRelApprox(q.amountOut, s.curveTokens, 1e-6, "sold out");
      // Paying one cent more does not buy anything extra.
      assert.ok(quoteBuy(s, all + 0.01).amountOut <= s.curveTokens + 1e-9);
    }
  });

  it("is monotonic and convex: each extra token costs more than the last", () => {
    const s = afterBuys(initialCurve(0), 2, 100);
    const step = s.curveTokens / 1000;
    let prevCost = 0;
    let prevMarginal = 0;
    for (let n = 1; n <= 500; n++) {
      const cost = usdcForTokens(s, step * n);
      const marginal = cost - prevCost;
      assert.ok(cost > prevCost, "cost increases with tokens");
      assert.ok(marginal >= prevMarginal - 1e-9, "marginal cost never decreases");
      prevCost = cost;
      prevMarginal = marginal;
    }
  });
});
