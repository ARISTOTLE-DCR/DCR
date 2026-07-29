import { BPS, Q192 } from "./constants.js";

export interface Observation { block: number; timestamp: number; sqrtPriceX96: bigint; liquidity: bigint; volumeWeth: bigint; swapCount: number; }
export interface State { version: 1; lastBlock: number; lastTimestamp: number; lastSqrtPriceX96: string; reserveWeth: string; reserveToken: string; integral: string; lastActionAt: number; }
export type Action = { kind: "hold"; reason: string } | { kind: "buy"|"sell"|"burn"; amount: bigint; score: bigint; reason: string };

export function abs(x: bigint): bigint { return x < 0n ? -x : x; }
export function clamp(x: bigint, lo: bigint, hi: bigint): bigint { return x < lo ? lo : x > hi ? hi : x; }
/** Signed, scale-free Q=10^6 log-price surrogate: relative movement of squared Q96 price. */
export function returnQ(oldSqrt: bigint, nowSqrt: bigint): bigint {
  if (oldSqrt <= 0n || nowSqrt <= 0n) return 0n;
  const s = 1_000_000n;
  return ((nowSqrt * nowSqrt - oldSqrt * oldSqrt) * s) / (oldSqrt * oldSqrt);
}
/** WETH/token as an exact rational numerator/denominator. */
export function priceRational(sqrt: bigint, tokenIs0: boolean): [bigint,bigint] {
  const square = sqrt * sqrt;
  return tokenIs0 ? [square,Q192] : [Q192,square];
}
export function valueTokenInWeth(tokenAmount: bigint, sqrt: bigint, tokenIs0: boolean): bigint {
  const [n,d] = priceRational(sqrt, tokenIs0); return tokenAmount * n / d;
}
/**
 * Discrete Curvature Reservoir controller. Pressure is order-flow energy per
 * liquidity. The controller opposes abrupt log-price motion, but only spends
 * the fee asset whose action reduces that motion. A cubic dead-zone suppresses
 * noise; at most 1/8 of either reserve is used per cycle.
 */
export function decide(obs: Observation, state: State, weth: bigint, token: bigint, tokenIs0: boolean): Action {
  if (state.lastSqrtPriceX96 === "0" || obs.liquidity === 0n) return {kind:"hold",reason:"initial observation or zero liquidity"};
  const poolReturn = returnQ(BigInt(state.lastSqrtPriceX96), obs.sqrtPriceX96);
  // V3 sqrt price is token1/token0; invert its direction when our token is token1.
  const r = tokenIs0 ? poolReturn : -poolReturn;
  const flow = obs.volumeWeth * 1_000_000n / (obs.liquidity + 1n);
  const threshold = 1_500n + clamp(flow,0n,25_000n) / 5n;
  const magnitude = abs(r);
  if (magnitude <= threshold) return {kind:"hold",reason:"movement lies inside adaptive curvature dead-zone"};
  const excess = magnitude - threshold;
  const score = excess * excess * excess / (threshold * threshold + 1n);
  const fractionBps = clamp(score / 200n, 25n, 1250n);
  if (r < 0n) {
    const amount = weth * fractionBps / BPS;
    return amount > 0n ? {kind:"buy",amount,score,reason:"negative price curvature: deploy WETH reservoir countercyclically"} : {kind:"hold",reason:"buy signal but WETH reservoir is empty"};
  }
  const sellAmount = token * fractionBps / BPS;
  if (sellAmount > 0n) return {kind:"sell",amount:sellAmount,score,reason:"positive price curvature: replenish WETH reservoir countercyclically"};
  return {kind:"hold",reason:"sell signal but token reservoir is empty"};
}
export function initialState(): State { return {version:1,lastBlock:0,lastTimestamp:0,lastSqrtPriceX96:"0",reserveWeth:"0",reserveToken:"0",integral:"0",lastActionAt:0}; }
export function nextDelayMs(random:()=>number=Math.random): number { return Math.floor((600 + random()*300)*1000); }
