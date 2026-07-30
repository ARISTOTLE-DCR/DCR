import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.js";

test("hold never touches the chain", async () => {
  const result = await execute(
    {} as never,
    { kind: "hold", reason: "dead-zone" },
    true,
  );
  assert.deepEqual(result, { status: "skipped", detail: "dead-zone" });
});

test("disabled signing turns a proposed trade into a deterministic dry-run", async () => {
  const result = await execute(
    {} as never,
    { kind: "buy", amount: 123n, score: 9n, reason: "test" },
    false,
  );
  assert.equal(result.status, "skipped");
  assert.match(result.detail, /dry-run buy 123/);
});

test("missing signer cannot accidentally transact", async () => {
  const result = await execute(
    {} as never,
    { kind: "sell", amount: 123n, score: 9n, reason: "test" },
    true,
  );
  assert.equal(result.status, "skipped");
});
