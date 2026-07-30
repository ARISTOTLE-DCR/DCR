import test from "node:test";
import assert from "node:assert/strict";
import {
  alignTick,
  decide,
  initialState,
  lpRange,
  nextDelayMs,
  priceRational,
  returnQ,
} from "../src/math.js";
const Q = 1n << 96n;
const base = { ...initialState("0x1"), lastSqrtPriceX96: Q.toString() };
const obs = (s: bigint, volume = 0n) => ({
  block: 100,
  timestamp: 1,
  sqrtPriceX96: s,
  tick: 0,
  tickSpacing: 200,
  liquidity: 1_000_000n,
  volumeWeth: volume,
  swapCount: 1,
});
test("exact rational price orientation", () => {
  assert.deepEqual(priceRational(2n, true), [4n, 1n << 192n]);
  assert.deepEqual(priceRational(2n, false), [1n << 192n, 4n]);
});
test("buy cone is readily reached on a fall", () =>
  assert.equal(
    decide(obs((Q * 99n) / 100n), base, 10_000n, 10_000n, true).kind,
    "buy",
  ));
test("ordinary positive curvature does not sell", () =>
  assert.notEqual(
    decide(obs((Q * 1001n) / 1000n), base, 10_000n, 30_000n, true).kind,
    "sell",
  ));
test("rare sell requires extreme rise and token solvency surplus", () =>
  assert.equal(
    decide(obs((Q * 101n) / 100n), base, 10_000n, 30_000n, true).kind,
    "sell",
  ));
test("calm token surplus burns", () =>
  assert.equal(decide(obs(Q), base, 10_000n, 30_000n, true).kind, "burn"));
test("calm balanced high flow makes permanent LP", () =>
  assert.equal(
    decide(obs(Q, 3_000n), base, 10_000n, 10_000n, true).kind,
    "permanent_lp",
  ));
test("calm WETH surplus makes available finalized airdrop", () =>
  assert.equal(
    decide(obs(Q), base, 30_000n, 10_000n, true, {
      holderCount: 10,
      holderIndexComplete: true,
    }).kind,
    "weth_airdrop",
  ));
test("airdrop is unavailable with incomplete index", () =>
  assert.equal(
    decide(obs(Q), base, 30_000n, 10_000n, true, {
      holderCount: 10,
      holderIndexComplete: false,
    }).kind,
    "hold",
  ));
test("inverted orientation buys a V3 rise", () =>
  assert.equal(
    decide(obs((Q * 101n) / 100n), base, 10_000n, 10_000n, false).kind,
    "buy",
  ));
test("all spend allocations are at most one eighth", () => {
  for (const a of [
    decide(obs((Q * 99n) / 100n), base, 80_000n, 80_000n, true),
    decide(obs((Q * 101n) / 100n), base, 80_000n, 240_000n, true),
    decide(obs(Q), base, 80_000n, 240_000n, true),
    decide(obs(Q, 3000n), base, 80_000n, 80_000n, true),
    decide(obs(Q), base, 240_000n, 80_000n, true, {
      holderCount: 3,
      holderIndexComplete: true,
    }),
  ]) {
    if ("amount" in a)
      assert(
        a.amount * 8n <=
          (a.kind === "buy"
            ? 80_000n
            : a.kind === "sell" || a.kind === "burn"
              ? 240_000n
              : 0n),
      );
    if (a.kind === "permanent_lp") {
      assert(a.amountWeth * 8n <= 80_000n);
      assert(a.amountToken * 8n <= 80_000n);
    }
    if (a.kind === "weth_airdrop") assert(a.total * 8n <= 240_000n);
  }
});
test("ticks align and range contains live tick", () => {
  assert.equal(alignTick(-1, 200, "down"), -200);
  const [lo, hi] = lpRange(123, 200, 3000n);
  assert.equal(Math.abs(lo % 200), 0);
  assert.equal(Math.abs(hi % 200), 0);
  assert(lo < 123 && 123 < hi);
});
test("integer return signs and cadence", () => {
  assert(returnQ(10n, 11n) > 0n);
  assert(returnQ(10n, 9n) < 0n);
  assert.equal(
    nextDelayMs(() => 0),
    600000,
  );
  assert(nextDelayMs(() => 0.999999) < 900000);
});
