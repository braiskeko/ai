/**
 * Constant-product bonding curve with virtual reserves (the pump.fun model).
 *
 *   (U + vU) · (T + vT) = k
 *
 *   U  = real USDC held by the curve           vU = VIRTUAL_USDC_RESERVE
 *   T  = tokens still inside the curve         vT = VIRTUAL_TOKEN_RESERVE
 *
 * Buying: the buyer pays `usdcIn`; a 2.7% fee is skimmed off the top and the rest
 * is added to U, releasing tokens so that k stays constant.
 * Selling: tokens go back into the curve, USDC is released, and the fee is taken
 * from the USDC the seller receives.
 *
 * Spot price (USDC per token) = (U + vU) / (T + vT).
 * Market cap = spot price × TOTAL_SUPPLY.
 */
import {
  SWAP_FEE,
  TOTAL_SUPPLY,
  VIRTUAL_TOKEN_RESERVE,
  VIRTUAL_USDC_RESERVE,
  CREATOR_FEE_SHARE,
} from "@shared/schema";

export interface CurveState {
  realUsdc: number;
  curveTokens: number;
}

export interface SwapResult {
  /** what the trader pays (buy: USDC incl. fee; sell: tokens) */
  amountIn: number;
  /** what the trader receives (buy: tokens; sell: USDC net of fee) */
  amountOut: number;
  fee: number;
  creatorFee: number;
  platformFee: number;
  priceBefore: number;
  priceAfter: number;
  priceImpact: number;
  next: CurveState;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function initialCurve(creatorAllocation: number): CurveState {
  // The creator's allocation is minted outside the curve, so fewer tokens are for sale.
  const forSale = TOTAL_SUPPLY * (1 - creatorAllocation);
  return { realUsdc: 0, curveTokens: forSale };
}

export function spotPrice(s: CurveState): number {
  return (s.realUsdc + VIRTUAL_USDC_RESERVE) / (s.curveTokens + VIRTUAL_TOKEN_RESERVE);
}

export function marketCap(s: CurveState): number {
  return spotPrice(s) * TOTAL_SUPPLY;
}

function splitFee(fee: number) {
  const creatorFee = round6(fee * CREATOR_FEE_SHARE);
  return { creatorFee, platformFee: round6(fee - creatorFee) };
}

/** Quote a buy of `usdcIn` USDC (fee included in `usdcIn`). */
export function quoteBuy(s: CurveState, usdcIn: number): SwapResult {
  if (!(usdcIn > 0)) throw new Error("amount must be positive");
  const fee = round6(usdcIn * SWAP_FEE);
  const net = usdcIn - fee;
  const U = s.realUsdc + VIRTUAL_USDC_RESERVE;
  const T = s.curveTokens + VIRTUAL_TOKEN_RESERVE;
  const k = U * T;
  const newT = k / (U + net);
  let tokensOut = T - newT;
  // never sell more than the curve holds
  if (tokensOut > s.curveTokens) tokensOut = s.curveTokens;
  const next: CurveState = { realUsdc: round6(s.realUsdc + net), curveTokens: s.curveTokens - tokensOut };
  const priceBefore = spotPrice(s);
  const priceAfter = spotPrice(next);
  return {
    amountIn: usdcIn,
    amountOut: tokensOut,
    fee,
    ...splitFee(fee),
    priceBefore,
    priceAfter,
    priceImpact: priceBefore > 0 ? priceAfter / priceBefore - 1 : 0,
    next,
  };
}

/** Quote a sale of `tokensIn` tokens; the fee is deducted from the USDC paid out. */
export function quoteSell(s: CurveState, tokensIn: number): SwapResult {
  if (!(tokensIn > 0)) throw new Error("amount must be positive");
  const U = s.realUsdc + VIRTUAL_USDC_RESERVE;
  const T = s.curveTokens + VIRTUAL_TOKEN_RESERVE;
  const k = U * T;
  const newU = k / (T + tokensIn);
  let grossOut = U - newU;
  // the curve can only pay out USDC it actually holds
  if (grossOut > s.realUsdc) grossOut = s.realUsdc;
  const fee = round6(grossOut * SWAP_FEE);
  const net = round6(grossOut - fee);
  const next: CurveState = { realUsdc: round6(s.realUsdc - grossOut), curveTokens: s.curveTokens + tokensIn };
  const priceBefore = spotPrice(s);
  const priceAfter = spotPrice(next);
  return {
    amountIn: tokensIn,
    amountOut: net,
    fee,
    ...splitFee(fee),
    priceBefore,
    priceAfter,
    priceImpact: priceBefore > 0 ? priceAfter / priceBefore - 1 : 0,
    next,
  };
}

/** USDC needed (fee included) to buy exactly `tokens` tokens from the curve. */
export function usdcForTokens(s: CurveState, tokens: number): number {
  const U = s.realUsdc + VIRTUAL_USDC_RESERVE;
  const T = s.curveTokens + VIRTUAL_TOKEN_RESERVE;
  const k = U * T;
  const net = k / (T - tokens) - U;
  return net / (1 - SWAP_FEE);
}
