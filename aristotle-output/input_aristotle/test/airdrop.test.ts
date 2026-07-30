import test from "node:test";
import assert from "node:assert/strict";
import { eligibleCommitment, makePlan } from "../src/airdrop.js";
const holders = Array.from(
  { length: 12 },
  (_, i) =>
    [`0x${(i + 1).toString(16).padStart(40, "0")}`, BigInt(i + 1)] as [
      string,
      bigint,
    ],
);
const seed = "0x" + "42".repeat(32);
test("deterministic sampling is unique and conserves total", () => {
  const a = makePlan(
    "0x" + "11".repeat(32),
    100,
    110,
    holders,
    seed,
    1003n,
    10,
  );
  const b = makePlan(
    "0x" + "11".repeat(32),
    100,
    110,
    holders,
    seed,
    1003n,
    10,
  );
  assert.deepEqual(a, b);
  assert.equal(new Set(a.recipients.map((x) => x.address)).size, 10);
  assert.equal(
    a.recipients.reduce((x, y) => x + BigInt(y.amount), 0n),
    1003n,
  );
});
test("supports one recipient and commits balances", () => {
  const p = makePlan("0x" + "22".repeat(32), 1, 2, holders, seed, 99n, 1);
  assert.equal(p.recipients.length, 1);
  assert.equal(p.eligibleSetHash, eligibleCommitment(holders));
});
test("rejects recipient counts beyond one through ten or eligibility", () => {
  assert.throws(() =>
    makePlan("0x" + "22".repeat(32), 1, 2, holders, seed, 1n, 0),
  );
  assert.throws(() =>
    makePlan("0x" + "22".repeat(32), 1, 2, holders.slice(0, 2), seed, 1n, 3),
  );
});
