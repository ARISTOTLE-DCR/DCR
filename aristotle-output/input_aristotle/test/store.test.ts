import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, tokenDataDir } from "../src/store.js";
test("migrates v1 baseline and persists schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcr-"));
  try {
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({
        version: 1,
        lastBlock: 9,
        lastSqrtPriceX96: "123",
        integral: "7",
      }),
    );
    const s = new Store(root);
    const state = await s.state("0xabc");
    assert.equal(state.version, 2);
    assert.equal(state.lastSqrtPriceX96, "123");
    state.nextRunAt = 123456;
    await s.saveState(state);
    assert.equal((await s.state("0xabc")).nextRunAt, 123456);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("journal preserves confirmed action identity and hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcr-"));
  try {
    const s = new Store(root),
      j = {
        cycleId: "c",
        block: 1,
        action: { kind: "buy" },
        stage: "confirmed" as const,
        txHashes: ["h"],
        createdAt: 1,
        updatedAt: 2,
      };
    await s.saveJournal(j);
    assert.deepEqual(await s.journal(), j);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("token data directories cannot collide", () =>
  assert.notEqual(tokenDataDir("data", "0x01"), tokenDataDir("data", "0x02")));
