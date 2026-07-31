export type Classification = "STRONG BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG BEARISH";

export interface NormalizedObservation {
  momentumPpm?: number;       // six-hour log-like relative return, saturated below
  recentMomentumPpm?: number; // one-hour return
  flowPpm?: number;           // signed WETH / absolute WETH
  activeTransactions: number;
  swaps: number;
  liquidityWethPpm?: number;  // sqrt(token reserve * WETH reserve), in micro-WETH
  completenessPpm: number;
  historySpanPpm: number;
}

export interface ModelResult {
  score: number;
  confidence: number;
  quality: number;
  label: Classification;
  metrics: { momentum: number; flow: number; impulse: number; breadth: number; depth: number };
  dominant: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sat = (x: number, scale: number) => clamp(Math.round((100 * x) / (Math.abs(x) + scale)), -100, 100);

/** Pure integer/fixed-point model: identical normalized observations imply identical output. */
export function evaluateModel(o: NormalizedObservation): ModelResult {
  const momentum = o.momentumPpm === undefined ? 0 : sat(o.momentumPpm, 80_000);
  const recent = o.recentMomentumPpm === undefined ? momentum : sat(o.recentMomentumPpm, 30_000);
  const flow = o.flowPpm === undefined ? 0 : clamp(Math.round(o.flowPpm / 10_000), -100, 100);
  const impulse = clamp(recent - Math.trunc(momentum / 2), -100, 100);
  const breadth = clamp(Math.round(100 * (1 - Math.exp(-o.activeTransactions / 8))), 0, 100);
  const depth = o.liquidityWethPpm === undefined ? 0 : clamp(Math.round(100 * o.liquidityWethPpm / (o.liquidityWethPpm + 5_000_000)), 0, 100);

  // Estimate latent direction, then shrink it by independent evidence quality.
  const direction = Math.round((50 * momentum + 30 * flow + 20 * impulse) / 100);
  const activity = clamp(Math.round(100 * (1 - Math.exp(-o.swaps / 12))), 0, 100);
  const quality = Math.round((45 * depth + 30 * breadth + 25 * activity) / 100);
  const availability = [o.momentumPpm, o.recentMomentumPpm, o.flowPpm, o.liquidityWethPpm].filter((x) => x !== undefined).length;
  const confidence = clamp(Math.round((o.completenessPpm / 10_000) * (o.historySpanPpm / 1_000_000) * (0.5 + availability / 8)), 0, 100);
  const reliability = Math.min(quality, confidence);
  const score = clamp(Math.round(direction * reliability / 100), -100, 100);
  const label = classify(score);

  const signed = [
    { n: "momentum", v: momentum }, { n: flow < 0 ? "sell pressure" : "buy pressure", v: flow }, { n: "impulse", v: impulse },
    { n: "breadth", v: breadth - 50 }, { n: "depth", v: depth - 50 }
  ].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const lead = signed[0]!;
  const dominant = `${lead.v >= 0 ? "support" : "drag"}: ${lead.n}`;
  return { score, confidence, quality, label, metrics: { momentum, flow, impulse, breadth, depth }, dominant };
}

export function classify(score: number): Classification {
  if (score >= 55) return "STRONG BULLISH";
  if (score >= 20) return "BULLISH";
  if (score > -20) return "NEUTRAL";
  if (score > -55) return "BEARISH";
  return "STRONG BEARISH";
}
