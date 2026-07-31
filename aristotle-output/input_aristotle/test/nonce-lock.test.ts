import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNonceLock } from "../src/nonce-lock.js";

test("shared nonce lock serializes one signer across concurrent tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcr-nonce-lock-"));
  const previous = process.env.TRANSACTION_LOCK_DIR;
  process.env.TRANSACTION_LOCK_DIR = root;
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all([
      withNonceLock("0xabc", async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      }),
      withNonceLock("0xabc", async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        active -= 1;
      }),
    ]);
    assert.equal(maximum, 1);
  } finally {
    if (previous === undefined) delete process.env.TRANSACTION_LOCK_DIR;
    else process.env.TRANSACTION_LOCK_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
