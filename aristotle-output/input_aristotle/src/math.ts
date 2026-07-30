import { BPS, Q192 } from "./constants.js";

export interface Observation {
  block: number;
  timestamp: number;
  sqrtPriceX96: bigint;
  tick: number;
  tickSpacing: number;
  liquidity: bigint;
  volumeWeth: bigint;
  swapCount: number;
}
export interface State {
  version: 2;
  token: string;
  lastBlock: number;
  lastTimestamp: number;
  lastSqrtPriceX96: string;
  reserveWeth: string;
  reserveToken: string;
  flowIntegral: string;
  lastActionAt: number;
  nextRunAt: number;
  cycleSeq: number;
  activeCycleId?: string;
  holderCursor: number;
}
export type Scored = { score: bigint; reason: string };
export type Action =
  | { kind: "hold"; reason: string }
  | ({ kind: "buy"; amount: bigint } & Scored)
  | ({ kind: "sell"; amount: bigint } & Scored)
  | ({ kind: "burn"; amount: bigint } & Scored)
  | ({
      kind: "permanent_lp";
      amountToken: bigint;
      amountWeth: bigint;
      tickLower: number;
      tickUpper: number;
    } & Scored)
  | ({
      kind: "weth_airdrop";
      total: bigint;
      recipientCount: number;
      snapshotBlock: number;
    } & Scored);
export interface PolicyAvailability {
  holderCount: number;
  holderIndexComplete: boolean;
}
export function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
export function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}
export function returnQ(oldSqrt: bigint, nowSqrt: bigint): bigint {
  if (oldSqrt <= 0n || nowSqrt <= 0n) return 0n;
  return (
    ((nowSqrt * nowSqrt - oldSqrt * oldSqrt) * 1_000_000n) / (oldSqrt * oldSqrt)
  );
}
export function priceRational(
  sqrt: bigint,
  tokenIs0: boolean,
): [bigint, bigint] {
  const q = sqrt * sqrt;
  return tokenIs0 ? [q, Q192] : [Q192, q];
}
export function valueTokenInWeth(
  amount: bigint,
  sqrt: bigint,
  tokenIs0: boolean,
): bigint {
  const [n, d] = priceRational(sqrt, tokenIs0);
  return (amount * n) / d;
}
export function alignTick(
  tick: number,
  spacing: number,
  direction: "down" | "up",
): number {
  if (spacing <= 0) throw new Error("invalid tick spacing");
  const q = Math.floor(tick / spacing);
  const low = q * spacing;
  return direction === "down" ? low : low === tick ? tick : low + spacing;
}
export function lpRange(
  tick: number,
  spacing: number,
  pressure: bigint,
): [number, number] {
  const widths = 12 + Number(clamp(pressure / 2_000n, 0n, 36n));
  let lo = alignTick(tick - widths * spacing, spacing, "down"),
    hi = alignTick(tick + widths * spacing, spacing, "up");
  lo = Math.max(-887272, lo);
  hi = Math.min(887272, hi);
  lo = alignTick(lo, spacing, "up");
  hi = alignTick(hi, spacing, "down");
  if (!(lo < tick && tick < hi && lo < hi))
    throw new Error("cannot derive live in-range LP ticks");
  return [lo, hi];
}
/**
 * DCR v2 uses a one-sided solvency cone. A fall beyond adaptive curvature d is
 * buy-admissible. A sell requires r>4d AND token inventory value>2 WETH; hence
 * its projection onto displacement is a strict subset of the corresponding
 * positive-curvature region. Calm surplus is irreversibly allocated: token
 * surplus burns, balanced high-flow capital becomes permanent LP, and WETH
 * surplus is distributed only when a finalized holder index is available.
 */
export function decide(
  obs: Observation,
  state: State,
  weth: bigint,
  token: bigint,
  tokenIs0: boolean,
  available: PolicyAvailability = {
    holderCount: 0,
    holderIndexComplete: false,
  },
): Action {
  if (state.lastSqrtPriceX96 === "0" || obs.liquidity === 0n)
    return { kind: "hold", reason: "initial observation or zero liquidity" };
  const raw = returnQ(BigInt(state.lastSqrtPriceX96), obs.sqrtPriceX96);
  const r = tokenIs0 ? raw : -raw;
  const flow = (obs.volumeWeth * 1_000_000n) / (obs.liquidity + 1n);
  const d = 1_500n + clamp(flow, 0n, 25_000n) / 5n;
  const magnitude = abs(r);
  const excess = magnitude > d ? magnitude - d : 0n;
  const score = (excess * excess * excess) / (d * d + 1n);
  const bps = clamp(score / 200n, 25n, 1250n);
  const tokenValue = valueTokenInWeth(token, obs.sqrtPriceX96, tokenIs0);
  if (r < -d) {
    const amount = (weth * bps) / BPS;
    return amount > 0n
      ? {
          kind: "buy",
          amount,
          score,
          reason:
            "one-sided curvature release: deploy WETH against a token drawdown",
        }
      : { kind: "hold", reason: "buy-admissible but WETH reservoir is empty" };
  }
  if (r > 4n * d && tokenValue > 2n * weth) {
    const amount = (token * bps) / BPS;
    return amount > 0n
      ? {
          kind: "sell",
          amount,
          score,
          reason:
            "exceptional sell cone: extreme rise and token-valued solvency surplus",
        }
      : {
          kind: "hold",
          reason: "sell cone reached but token reservoir is empty",
        };
  }
  // Allocation gates operate only outside material curvature, preventing them from fighting a shock.
  if (magnitude <= d) {
    if (tokenValue > 2n * weth && token > 0n) {
      const amount = (token * 625n) / BPS;
      return amount > 0n
        ? {
            kind: "burn",
            amount,
            score: tokenValue - weth,
            reason: "calm token-surplus potential is irreversibly dissipated",
          }
        : { kind: "hold", reason: "burn allocation rounds to zero" };
    }
    if (
      weth > 0n &&
      tokenValue > 0n &&
      tokenValue * 2n >= weth &&
      tokenValue <= 2n * weth &&
      flow >= 2_000n
    ) {
      const [tickLower, tickUpper] = lpRange(obs.tick, obs.tickSpacing, flow);
      const amountWeth = (weth * 1000n) / BPS,
        amountToken = (token * 1000n) / BPS;
      return amountWeth > 0n && amountToken > 0n
        ? {
            kind: "permanent_lp",
            amountToken,
            amountWeth,
            tickLower,
            tickUpper,
            score: flow,
            reason:
              "balanced high-flow reservoir is converted to permanently locked depth",
          }
        : { kind: "hold", reason: "LP allocation rounds to zero" };
    }
    if (
      weth > 2n * tokenValue &&
      available.holderIndexComplete &&
      available.holderCount > 0
    ) {
      const total = (weth * 625n) / BPS;
      const recipientCount = Math.min(
        10,
        available.holderCount,
        Math.max(1, Number(clamp(total / 10_000_000_000_000_000n, 1n, 10n))),
      );
      return total > 0n
        ? {
            kind: "weth_airdrop",
            total,
            recipientCount,
            snapshotBlock: obs.block - 12,
            score: weth - tokenValue,
            reason: "calm WETH surplus is diffused to finalized token holders",
          }
        : { kind: "hold", reason: "airdrop allocation rounds to zero" };
    }
  }
  return {
    kind: "hold",
    reason:
      r > 0n
        ? "rise is outside the narrow sell solvency cone"
        : "movement lies inside allocation and curvature dead-zones",
  };
}
export function initialState(token = ""): State {
  return {
    version: 2,
    token,
    lastBlock: 0,
    lastTimestamp: 0,
    lastSqrtPriceX96: "0",
    reserveWeth: "0",
    reserveToken: "0",
    flowIntegral: "0",
    lastActionAt: 0,
    nextRunAt: 0,
    cycleSeq: 0,
    holderCursor: 0,
  };
}
export function nextDelayMs(random: () => number = Math.random): number {
  return Math.floor((600 + random() * 300) * 1000);
}
