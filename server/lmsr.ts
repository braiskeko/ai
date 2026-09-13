/**
 * Logarithmic Market Scoring Rule (LMSR) automated market maker for N outcomes.
 *
 * State: q[i] = outstanding shares of outcome i, b = liquidity parameter.
 *
 *   C(q)   = b * ln( Σ_i e^(q_i / b) )          cost function
 *   p_i(q) = e^(q_i/b) / Σ_j e^(q_j/b)          price (= probability) of outcome i
 *
 * Buying `d` shares of outcome i costs C(q + d·e_i) - C(q).
 * Each share pays out 1 USDC if that outcome wins. Prices always sum to 1.
 * The market maker's worst-case loss is bounded by b · ln(N).
 */

export interface LmsrState {
  liquidity: number;
  q: number[];
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

export function cost(state: LmsrState): number {
  return state.liquidity * logSumExp(state.q.map((x) => x / state.liquidity));
}

export function prices(state: LmsrState): number[] {
  const scaled = state.q.map((x) => x / state.liquidity);
  const m = Math.max(...scaled);
  const exps = scaled.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function price(state: LmsrState, outcome: number): number {
  return prices(state)[outcome];
}

function withDelta(state: LmsrState, outcome: number, delta: number): LmsrState {
  const q = state.q.slice();
  q[outcome] += delta;
  return { liquidity: state.liquidity, q };
}

/** USDC cost of buying `shares` of `outcome` (negative shares = selling, returns negative). */
export function costOfShares(state: LmsrState, outcome: number, shares: number): number {
  return cost(withDelta(state, outcome, shares)) - cost(state);
}

/** Shares of `outcome` obtainable for `amount` USDC, by bisection on the monotone cost function. */
export function sharesForAmount(state: LmsrState, outcome: number, amount: number): number {
  if (amount <= 0) return 0;
  let lo = 0;
  let hi = amount; // shares cost at most 1 each, so `amount` shares is an upper bound
  // The upper bound can be too tight when price is ~1 due to rounding; widen if needed.
  while (costOfShares(state, outcome, hi) < amount && hi < amount * 1e6) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (costOfShares(state, outcome, mid) < amount) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/**
 * Initial quantities so the market opens at the given probabilities.
 * p_i ∝ e^(q_i/b)  =>  q_i = b · ln(p_i) + const. We shift so min(q) = 0.
 */
export function initialQuantities(liquidity: number, probabilities: number[]): number[] {
  const clamped = probabilities.map((p) => Math.min(0.99, Math.max(0.005, p)));
  const sum = clamped.reduce((a, b) => a + b, 0);
  const logs = clamped.map((p) => Math.log(p / sum));
  const min = Math.min(...logs);
  return logs.map((l) => liquidity * (l - min));
}

export interface Quote {
  outcomeId: number;
  side: "buy" | "sell";
  shares: number;
  amount: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  maxPayout: number;
  nextState: LmsrState;
  pricesAfter: number[];
}

export function quoteBuy(state: LmsrState, outcome: number, amount: number): Quote {
  const shares = sharesForAmount(state, outcome, amount);
  const nextState = withDelta(state, outcome, shares);
  const pricesAfter = prices(nextState);
  return {
    outcomeId: outcome,
    side: "buy",
    shares,
    amount,
    avgPrice: shares > 0 ? amount / shares : price(state, outcome),
    priceBefore: price(state, outcome),
    priceAfter: pricesAfter[outcome],
    maxPayout: shares,
    nextState,
    pricesAfter,
  };
}

export function quoteSell(state: LmsrState, outcome: number, shares: number): Quote {
  const received = -costOfShares(state, outcome, -shares);
  const nextState = withDelta(state, outcome, -shares);
  const pricesAfter = prices(nextState);
  return {
    outcomeId: outcome,
    side: "sell",
    shares,
    amount: received,
    avgPrice: shares > 0 ? received / shares : price(state, outcome),
    priceBefore: price(state, outcome),
    priceAfter: pricesAfter[outcome],
    maxPayout: 0,
    nextState,
    pricesAfter,
  };
}
