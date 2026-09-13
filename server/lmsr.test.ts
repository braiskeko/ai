import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cost,
  costOfShares,
  initialQuantities,
  price,
  prices,
  quoteBuy,
  quoteSell,
  sharesForAmount,
  type LmsrState,
} from "./lmsr";

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

function randomState(rand: () => number, n: number, liquidity: number): LmsrState {
  return { liquidity, q: Array.from({ length: n }, () => rand() * 5 * liquidity) };
}

/** State whose opening prices are exactly `probs` (prices are shift-invariant, so no need to normalise q). */
function stateFromProbs(liquidity: number, probs: number[]): LmsrState {
  return { liquidity, q: probs.map((p) => liquidity * Math.log(p)) };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function assertFinite(x: number, label: string) {
  assert.ok(Number.isFinite(x), `${label} should be finite, got ${x}`);
}

function assertApprox(actual: number, expected: number, tol: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${actual} ≈ ${expected} (|diff| ${Math.abs(actual - expected)} > ${tol})`,
  );
}

function assertRelApprox(actual: number, expected: number, relTol: number, label: string) {
  assertApprox(actual, expected, relTol * Math.max(1e-300, Math.abs(expected)), label);
}

const OUTCOME_COUNTS = [2, 3, 4, 5, 6, 7, 8];
const LIQUIDITIES = [1, 10, 100, 1000];

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

describe("prices", () => {
  it("sum to 1 and lie strictly inside (0, 1) for random states with 2..8 outcomes", () => {
    const rand = rng(1);
    for (const n of OUTCOME_COUNTS) {
      for (let trial = 0; trial < 50; trial++) {
        const liquidity = 1 + rand() * 999;
        const state = randomState(rand, n, liquidity);
        const p = prices(state);
        assert.equal(p.length, n);
        assertApprox(sum(p), 1, 1e-12, `sum of prices (n=${n})`);
        for (let i = 0; i < n; i++) {
          assert.ok(p[i] > 0 && p[i] < 1, `price ${p[i]} of outcome ${i} must be in (0,1)`);
          assert.equal(price(state, i), p[i], "price(state, i) must agree with prices(state)[i]");
        }
      }
    }
  });

  it("are uniform (1/N) and cost is b·ln(N) when every outcome has the same quantity", () => {
    for (const n of OUTCOME_COUNTS) {
      for (const b of LIQUIDITIES) {
        for (const q of [0, 3.5 * b]) {
          const state: LmsrState = { liquidity: b, q: new Array(n).fill(q) };
          for (const p of prices(state)) assertApprox(p, 1 / n, 1e-15, `uniform price n=${n}`);
          assertApprox(cost(state), q + b * Math.log(n), 1e-9 * Math.max(1, q), `cost of uniform state n=${n} b=${b}`);
        }
      }
    }
  });

  it("only depend on quantity differences (shift invariance)", () => {
    const rand = rng(11);
    for (let trial = 0; trial < 20; trial++) {
      const state = randomState(rand, 5, 100);
      const shifted: LmsrState = { liquidity: 100, q: state.q.map((x) => x + 1234.5) };
      const a = prices(state);
      const s = prices(shifted);
      for (let i = 0; i < 5; i++) assertApprox(s[i], a[i], 1e-12, `shifted price ${i}`);
    }
  });

  it("rise for the outcome that is bought and fall for every other outcome", () => {
    const rand = rng(2);
    for (const n of OUTCOME_COUNTS) {
      for (let trial = 0; trial < 20; trial++) {
        const b = 10 + rand() * 490;
        const state = randomState(rand, n, b);
        const outcome = Math.floor(rand() * n);
        const before = prices(state);
        const quote = quoteBuy(state, outcome, 1 + rand() * 2 * b);
        const after = quote.pricesAfter;

        assert.ok(after[outcome] > before[outcome], `bought outcome ${outcome} must get more expensive`);
        for (let i = 0; i < n; i++) {
          if (i === outcome) continue;
          assert.ok(after[i] < before[i], `outcome ${i} must get cheaper when ${outcome} is bought`);
        }
        assertApprox(sum(after), 1, 1e-12, "prices after a buy still sum to 1");
        assert.equal(quote.priceBefore, before[outcome]);
        assert.equal(quote.priceAfter, after[outcome]);
        assert.deepEqual(prices(quote.nextState), after);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// costOfShares
// ---------------------------------------------------------------------------

describe("costOfShares", () => {
  it("is zero for zero shares, negative when selling and strictly increasing in shares", () => {
    const rand = rng(3);
    for (const n of OUTCOME_COUNTS) {
      for (const b of LIQUIDITIES) {
        const state = randomState(rand, n, b);
        const outcome = Math.floor(rand() * n);
        assert.equal(costOfShares(state, outcome, 0), 0);

        const grid = [-50, -20, -5, -1, -0.1, -0.001, 0, 0.001, 0.1, 1, 5, 20, 50, 200].map((x) => x * b);
        const costs = grid.map((shares) => costOfShares(state, outcome, shares));
        for (let i = 1; i < grid.length; i++) {
          assert.ok(
            costs[i] > costs[i - 1],
            `cost must increase with shares (b=${b}, n=${n}): cost(${grid[i - 1]})=${costs[i - 1]} vs cost(${grid[i]})=${costs[i]}`,
          );
          if (grid[i] > 0) assert.ok(costs[i] > 0, "buying costs money");
          if (grid[i] < 0) assert.ok(costs[i] < 0, "selling returns money (negative cost)");
        }
      }
    }
  });

  it("charges between the pre-trade and post-trade marginal price per share (convexity)", () => {
    const rand = rng(31);
    for (let trial = 0; trial < 100; trial++) {
      const n = 2 + Math.floor(rand() * 7);
      const b = 1 + rand() * 999;
      const state = randomState(rand, n, b);
      const outcome = Math.floor(rand() * n);
      const shares = rand() * 3 * b;
      const c = costOfShares(state, outcome, shares);
      const pBefore = price(state, outcome);
      const pAfter = price({ liquidity: b, q: state.q.map((x, i) => (i === outcome ? x + shares : x)) }, outcome);
      assert.ok(c >= pBefore * shares - 1e-9, `cost ${c} must be ≥ shares·priceBefore ${pBefore * shares}`);
      assert.ok(c <= pAfter * shares + 1e-9, `cost ${c} must be ≤ shares·priceAfter ${pAfter * shares}`);
      assert.ok(c < shares, "a share can never cost more than its 1 USDC payout");
    }
  });
});

// ---------------------------------------------------------------------------
// sharesForAmount
// ---------------------------------------------------------------------------

describe("sharesForAmount", () => {
  it("returns 0 for a non-positive amount", () => {
    const state: LmsrState = { liquidity: 100, q: [0, 0] };
    assert.equal(sharesForAmount(state, 0, 0), 0);
    assert.equal(sharesForAmount(state, 1, -5), 0);
  });

  it("inverts costOfShares (cost of returned shares ≈ amount) from 0.1 USDC up to 10× liquidity", () => {
    const rand = rng(4);
    for (const b of LIQUIDITIES) {
      for (const n of [2, 3, 5, 8]) {
        const state = randomState(rand, n, b);
        const amounts = [0.1, 0.25, 1, 2.5, 0.1 * b, 0.5 * b, b, 2 * b, 5 * b, 10 * b];
        for (let outcome = 0; outcome < n; outcome++) {
          for (const amount of amounts) {
            const shares = sharesForAmount(state, outcome, amount);
            assert.ok(shares > 0, `shares for ${amount} USDC must be positive`);
            assert.ok(shares >= amount, "each share costs at most 1 USDC, so you get at least `amount` shares");
            const c = costOfShares(state, outcome, shares);
            assertRelApprox(c, amount, 1e-6, `cost of sharesForAmount(b=${b}, n=${n}, o=${outcome}, amount=${amount})`);
          }
        }
      }
    }
  });

  it("inverts costOfShares in extreme states (prices ≈ 0.001 and ≈ 0.999)", () => {
    for (const b of LIQUIDITIES) {
      const cases: { state: LmsrState; label: string; expectMin?: number; expectMax?: number }[] = [
        { state: stateFromProbs(b, [0.001, 0.999]), label: "binary", expectMin: 0.001, expectMax: 0.999 },
        { state: stateFromProbs(b, [0.001, 0.999 / 4, 0.999 / 4, 0.999 / 4, 0.999 / 4]), label: "5-way with one ~0.001", expectMin: 0.001 },
        { state: stateFromProbs(b, [0.999, 0.001 / 4, 0.001 / 4, 0.001 / 4, 0.001 / 4]), label: "5-way with one ~0.999", expectMax: 0.999 },
      ];
      for (const { state, label, expectMin, expectMax } of cases) {
        const p = prices(state);
        if (expectMin !== undefined) assertApprox(Math.min(...p), expectMin, 1e-12, `${label} has a price ≈ ${expectMin}`);
        if (expectMax !== undefined) assertApprox(Math.max(...p), expectMax, 1e-12, `${label} has a price ≈ ${expectMax}`);
        for (let outcome = 0; outcome < state.q.length; outcome++) {
          for (const amount of [0.1, 1, 0.1 * b, b, 10 * b]) {
            const shares = sharesForAmount(state, outcome, amount);
            assertFinite(shares, `shares (${label}, b=${b}, o=${outcome}, amount=${amount})`);
            assert.ok(shares > 0);
            const c = costOfShares(state, outcome, shares);
            assertRelApprox(c, amount, 1e-6, `cost of shares (${label}, b=${b}, o=${outcome} p=${p[outcome]}, amount=${amount})`);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// quoteBuy / quoteSell
// ---------------------------------------------------------------------------

describe("quoteBuy / quoteSell", () => {
  it("buy then sell of the same shares returns what was paid (no free money beyond float noise) and restores the state", () => {
    const rand = rng(5);
    for (const n of OUTCOME_COUNTS) {
      for (const b of LIQUIDITIES) {
        for (let trial = 0; trial < 10; trial++) {
          const state = randomState(rand, n, b);
          const outcome = Math.floor(rand() * n);
          const amount = 0.1 + rand() * 10 * b;
          const p0 = prices(state);

          const buy = quoteBuy(state, outcome, amount);
          assert.equal(buy.side, "buy");
          assert.equal(buy.outcomeId, outcome);
          assert.equal(buy.amount, amount);
          assert.equal(buy.maxPayout, buy.shares);
          assert.ok(buy.shares > amount, "must receive more shares than USDC paid since price < 1");
          assertRelApprox(buy.avgPrice, amount / buy.shares, 1e-12, "buy avgPrice");
          assert.ok(buy.priceBefore < buy.avgPrice && buy.avgPrice < buy.priceAfter, "buy avg price sits between marginal prices");

          const sell = quoteSell(buy.nextState, outcome, buy.shares);
          assert.equal(sell.side, "sell");
          assert.equal(sell.shares, buy.shares);
          assert.equal(sell.maxPayout, 0);
          const tol = 1e-9 * Math.max(1, amount);
          assert.ok(
            sell.amount <= amount + tol,
            `selling back must not return more than paid: paid ${amount}, received ${sell.amount}`,
          );
          assertApprox(sell.amount, amount, 1e-6 * Math.max(1, amount), "round-trip difference must be tiny");
          assert.ok(sell.priceAfter < sell.avgPrice && sell.avgPrice < sell.priceBefore, "sell avg price sits between marginal prices");
          assertApprox(sell.priceAfter, buy.priceBefore, 1e-12, "price after round trip");

          // State is restored (up to floating point rounding of q[i] + s - s).
          assert.equal(sell.nextState.liquidity, state.liquidity);
          for (let i = 0; i < n; i++) {
            assertApprox(sell.nextState.q[i], state.q[i], 1e-9 * Math.max(1, Math.abs(state.q[i])), `restored q[${i}]`);
            assertApprox(sell.pricesAfter[i], p0[i], 1e-12, `restored price[${i}]`);
          }
        }
      }
    }
  });

  it("selling never pays more than the face value of the shares and less than the pre-trade price", () => {
    const rand = rng(51);
    for (let trial = 0; trial < 100; trial++) {
      const n = 2 + Math.floor(rand() * 7);
      const b = 1 + rand() * 999;
      const state = randomState(rand, n, b);
      const outcome = Math.floor(rand() * n);
      const shares = rand() * 5 * b;
      const sell = quoteSell(state, outcome, shares);
      assert.ok(sell.amount >= 0 && sell.amount <= shares, `received ${sell.amount} for ${shares} shares`);
      assert.ok(sell.amount <= sell.priceBefore * shares + 1e-9, "selling pushes the price down, so you get less than the spot price");
    }
  });

  it("a zero-amount buy quote is a no-op with sane fields", () => {
    const state: LmsrState = { liquidity: 100, q: [10, 20, 30] };
    const quote = quoteBuy(state, 1, 0);
    assert.equal(quote.shares, 0);
    assert.equal(quote.amount, 0);
    assert.equal(quote.maxPayout, 0);
    assert.equal(quote.avgPrice, price(state, 1));
    assert.deepEqual(quote.nextState.q, state.q);
  });
});

// ---------------------------------------------------------------------------
// initialQuantities
// ---------------------------------------------------------------------------

describe("initialQuantities", () => {
  const normalise = (ps: number[]) => ps.map((p) => p / sum(ps));

  it("opens the market at the given (normalised) probabilities with min(q) = 0, binary and multi-outcome", () => {
    const cases = [
      [0.5, 0.5],
      [0.3, 0.7],
      [0.05, 0.95],
      [0.01, 0.99],
      [0.2, 0.6], // sums to 0.8 -> normalised to [0.25, 0.75]
      [1 / 3, 1 / 3, 1 / 3],
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.5, 0.5, 0.5], // sums to 2 -> 0.25 each
      [0.6, 0.1, 0.1, 0.1, 0.1],
      [0.02, 0.03, 0.05, 0.1, 0.1, 0.2, 0.2, 0.3],
    ];
    for (const probs of cases) {
      for (const b of [1, 50, 100, 1000]) {
        const q = initialQuantities(b, probs);
        assert.equal(q.length, probs.length);
        assert.equal(Math.min(...q), 0, "quantities are shifted so the cheapest outcome has q = 0");
        for (const x of q) assert.ok(x >= 0 && Number.isFinite(x));
        const p = prices({ liquidity: b, q });
        const expected = normalise(probs);
        for (let i = 0; i < probs.length; i++) {
          assertApprox(p[i], expected[i], 1e-9, `opening price ${i} for probs=[${probs}] b=${b}`);
        }
      }
    }
  });

  it("scales linearly with liquidity", () => {
    const probs = [0.1, 0.2, 0.3, 0.4];
    const q1 = initialQuantities(100, probs);
    const q2 = initialQuantities(250, probs);
    for (let i = 0; i < probs.length; i++) assertApprox(q2[i], 2.5 * q1[i], 1e-9, `q[${i}] scales with b`);
  });

  it("clamps extreme probabilities so no outcome opens at exactly 0 or 1", () => {
    const cases = [
      [0, 1],
      [1, 0],
      [1e-9, 1 - 1e-9],
      [0.001, 0.999],
      [1, 0, 0, 0],
      [0, 0, 0, 1],
      [0.999, 0.0005, 0.0005],
      [-1, 2], // garbage input still yields a valid market
    ];
    for (const probs of cases) {
      const b = 100;
      const q = initialQuantities(b, probs);
      for (const x of q) assertFinite(x, `q for probs=[${probs}]`);
      assert.equal(Math.min(...q), 0);
      const p = prices({ liquidity: b, q });
      assertApprox(sum(p), 1, 1e-12, "clamped prices sum to 1");
      for (const x of p) {
        assertFinite(x, "clamped price");
        assert.ok(x >= 0.004 && x <= 0.996, `clamped price ${x} for probs=[${probs}] must stay away from 0 and 1`);
      }
      // Exact documented behaviour: clamp each p into [0.005, 0.99], then normalise.
      const expected = normalise(probs.map((x) => Math.min(0.99, Math.max(0.005, x))));
      for (let i = 0; i < probs.length; i++) assertApprox(p[i], expected[i], 1e-9, `clamped price ${i} for probs=[${probs}]`);
      // Ordering of the inputs is preserved.
      for (let i = 0; i < probs.length; i++) {
        for (let j = 0; j < probs.length; j++) {
          if (probs[i] > probs[j]) assert.ok(p[i] >= p[j], "higher input probability never opens cheaper");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// market maker liability
// ---------------------------------------------------------------------------

describe("market maker worst-case loss", () => {
  /**
   * Runs `trades` random buys (and some sells of previously bought shares) against
   * a market and asserts after every trade that
   *     max_i(traders' holdings of i) − USDC collected ≤ bound + 1e-6
   * i.e. whichever outcome resolves YES, the market maker never loses more than `bound`.
   */
  function simulate(seed: number, start: LmsrState, bound: number, trades: number) {
    const rand = rng(seed);
    const n = start.q.length;
    const b = start.liquidity;
    let state: LmsrState = { liquidity: b, q: start.q.slice() };
    const holdings = new Array<number>(n).fill(0);
    let collected = 0;
    let worst = -Infinity;

    for (let t = 0; t < trades; t++) {
      const outcome = Math.floor(rand() * n);
      if (rand() < 0.25 && holdings[outcome] > 1e-9) {
        const shares = holdings[outcome] * rand();
        const q = quoteSell(state, outcome, shares);
        collected -= q.amount;
        holdings[outcome] -= shares;
        state = q.nextState;
      } else {
        // Skewed sizes: many small trades, occasional whales (up to 20·b).
        const amount = rand() < 0.1 ? rand() * 20 * b : 0.1 + rand() * b;
        const q = quoteBuy(state, outcome, amount);
        collected += amount;
        holdings[outcome] += q.shares;
        state = q.nextState;
      }
      const liability = Math.max(...holdings) - collected;
      worst = Math.max(worst, liability);
      assert.ok(
        liability <= bound + 1e-6,
        `after ${t + 1} trades (n=${n}, b=${b}) worst-case loss ${liability} exceeds bound ${bound}`,
      );
      for (const x of state.q) assertFinite(x, "q during simulation");
    }
    return worst;
  }

  it("never exceeds b·ln(N) over hundreds of random trades from a uniform opening", () => {
    let seed = 100;
    for (const n of [2, 3, 5, 8]) {
      for (const b of [10, 100, 1000]) {
        const start: LmsrState = { liquidity: b, q: new Array(n).fill(0) };
        const worst = simulate(seed++, start, b * Math.log(n), 400);
        assert.ok(worst > 0, "a random trade sequence should create some liability");
      }
    }
  });

  it("is approached (but not exceeded) when a single outcome is bought heavily", () => {
    for (const n of [2, 4, 8]) {
      const b = 100;
      const state: LmsrState = { liquidity: b, q: new Array(n).fill(0) };
      const bound = b * Math.log(n);
      const quote = quoteBuy(state, 0, 100 * b);
      const liability = quote.shares - quote.amount;
      assert.ok(liability <= bound + 1e-6, `liability ${liability} exceeds bound ${bound}`);
      assertApprox(liability, bound, 1e-6, "a one-sided market saturates the b·ln(N) bound");
    }
  });

  it("from a non-uniform opening is bounded by C(q0) − min(q0) = b·ln(1 / p_min)", () => {
    let seed = 200;
    for (const probs of [
      [0.7, 0.3],
      [0.7, 0.2, 0.1],
      [0.4, 0.3, 0.2, 0.05, 0.05],
    ]) {
      for (const b of [10, 100]) {
        const q0 = initialQuantities(b, probs);
        const start: LmsrState = { liquidity: b, q: q0 };
        const bound = cost(start) - Math.min(...q0);
        assertApprox(bound, b * Math.log(1 / Math.min(...probs)), 1e-9, "closed form of the bound");
        simulate(seed++, start, bound, 300);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// numerical stability
// ---------------------------------------------------------------------------

describe("numerical stability", () => {
  it("handles quantities up to 50·b without NaN or Infinity, and quotes still invert correctly", () => {
    for (const b of [1, 100, 10_000]) {
      const states: LmsrState[] = [
        { liquidity: b, q: [50 * b, 0, 0] },
        { liquidity: b, q: [0, 50 * b] },
        { liquidity: b, q: [50 * b, 50 * b, 0] },
        { liquidity: b, q: [50 * b, 49 * b, 48 * b, 0] },
        { liquidity: b, q: [-50 * b, 0, 50 * b] },
      ];
      for (const state of states) {
        const n = state.q.length;
        const c = cost(state);
        assertFinite(c, `cost for q=[${state.q}] b=${b}`);
        assert.ok(c >= Math.max(...state.q), "C(q) ≥ max(q)");
        const p = prices(state);
        assertApprox(sum(p), 1, 1e-12, "prices sum to 1 at extreme q");
        for (const x of p) {
          assertFinite(x, "extreme price");
          assert.ok(x >= 0 && x <= 1, `extreme price ${x} must stay within [0,1]`);
        }
        // e^-50 ≈ 2e-22 is far above the underflow threshold, so the tiny prices must stay
        // strictly positive (the dominant price legitimately rounds to exactly 1 in doubles).
        assert.ok(Math.min(...p) > 0, `smallest price ${Math.min(...p)} at q=[${state.q}] must not underflow to 0`);
        for (let outcome = 0; outcome < n; outcome++) {
          for (const shares of [-b, -0.5, 0.5, b, 10 * b]) {
            assertFinite(costOfShares(state, outcome, shares), `costOfShares(q=[${state.q}], o=${outcome}, s=${shares})`);
          }
          for (const amount of [0.1, b, 10 * b]) {
            const buy = quoteBuy(state, outcome, amount);
            for (const [k, v] of Object.entries(buy)) {
              if (typeof v === "number") assertFinite(v, `quoteBuy.${k} (q=[${state.q}], o=${outcome}, amount=${amount})`);
            }
            for (const x of buy.nextState.q) assertFinite(x, "nextState.q after extreme buy");
            for (const x of buy.pricesAfter) assertFinite(x, "pricesAfter extreme buy");

            const label = `q=[${state.q}] b=${b} o=${outcome} amount=${amount}`;
            const c = costOfShares(state, outcome, buy.shares);
            assert.ok(c <= amount * (1 + 1e-6), `trader must never receive shares worth more than paid (${label}: cost ${c})`);
            // sharesForAmount searches at most 1e6 × amount shares (see the dedicated test below), so
            // the exact inverse is only guaranteed when the fill stayed below that cap.
            const hitSearchCap = buy.shares >= amount * 1e6;
            if (!hitSearchCap) assertRelApprox(c, amount, 1e-6, `inverse at extreme ${label}`);

            const sell = quoteSell(buy.nextState, outcome, buy.shares);
            for (const [k, v] of Object.entries(sell)) {
              if (typeof v === "number") assertFinite(v, `quoteSell.${k} (${label})`);
            }
            assert.ok(sell.amount <= amount * (1 + 1e-6), `round trip must not create money (${label})`);
            if (!hitSearchCap) assertApprox(sell.amount, amount, 1e-6 * Math.max(1, amount), `round trip at extreme ${label}`);
          }
        }
      }
    }
  });

  it("sharesForAmount stops searching at 1e6 × amount shares (known limitation: an outcome priced below ~1e-6 is under-filled, never over-filled)", () => {
    // Outcome 1 is priced at ~e^-50 ≈ 2e-22, so 0.1 USDC is fairly worth ~385,000 shares —
    // more than the 1e6 × amount = 100,000 shares the bisection is willing to look for.
    const b = 10_000;
    const state: LmsrState = { liquidity: b, q: [50 * b, 0, 0] };
    const amount = 0.1;
    const shares = sharesForAmount(state, 1, amount);
    assertFinite(shares, "capped shares");
    assert.ok(shares >= amount * 1e6 && shares < amount * 2e6, `fill ${shares} should sit at the search cap`);
    const c = costOfShares(state, 1, shares);
    assertFinite(c, "cost of capped fill");
    assert.ok(c <= amount, `the trader is never handed shares worth more than they paid (cost ${c}, paid ${amount})`);
    assert.ok(c < amount / 2, `the fill is far short of fair value (cost ${c} vs paid ${amount})`);
    // The market maker is still safe: selling the fill back returns no more than was paid.
    assert.ok(quoteSell(quoteBuy(state, 1, amount).nextState, 1, shares).amount <= amount);
  });

  it("does not overflow even when q/b is far beyond the range where exp() overflows", () => {
    // e^800 is Infinity in double precision; the log-sum-exp trick must keep things finite.
    for (const b of [1, 100]) {
      const state: LmsrState = { liquidity: b, q: [800 * b, 0, 400 * b, 799 * b] };
      const c = cost(state);
      assertFinite(c, "cost at q/b = 800");
      assertApprox(c, 800 * b + b * Math.log(1 + Math.exp(-1)), 1e-9 * 800 * b, "cost dominated by the two largest terms");
      const p = prices(state);
      assertApprox(sum(p), 1, 1e-12, "prices sum to 1 at q/b = 800");
      for (const x of p) {
        assertFinite(x, "price at q/b = 800");
        assert.ok(x >= 0 && x <= 1);
      }
      assert.ok(p[0] > p[3] && p[3] > p[2] && p[2] >= p[1], "ordering preserved");
      assertFinite(costOfShares(state, 0, b), "costOfShares at q/b = 800");
      assertFinite(costOfShares(state, 1, b), "costOfShares of the negligible outcome");
    }
  });
});
