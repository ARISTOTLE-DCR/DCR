import assert from "node:assert/strict";
import {
  JsonRpcProvider,
  JsonRpcSigner,
} from "../aristotle-output/input_aristotle/node_modules/ethers/lib.esm/index.js";
import {
  balances,
  discover,
  observe,
} from "../aristotle-output/input_aristotle/dist/chain.js";
import {
  execute,
} from "../aristotle-output/input_aristotle/dist/executor.js";
import {
  decide,
  initialState,
} from "../aristotle-output/input_aristotle/dist/math.js";

const RPC = "http://127.0.0.1:18547";
const TOKEN = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const CREATOR = "0x68379906988495826B2521305E0E4de8FF5A8911";

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
await provider.send("anvil_setBalance", [
  CREATOR,
  "0x8ac7230489e80000",
]);
await provider.send("anvil_impersonateAccount", [CREATOR]);
const signer = new JsonRpcSigner(provider, CREATOR);
const ctx = { ...(await discover(RPC, TOKEN)), signer };

const baselineObservation = await observe(ctx, 0);
const baselineState = {
  ...initialState(),
  lastBlock: baselineObservation.block,
  lastTimestamp: baselineObservation.timestamp,
  lastSqrtPriceX96: baselineObservation.sqrtPriceX96.toString(),
};
const beforeShock = await balances(ctx);
const shockAmount = beforeShock.weth / 2n;
assert.ok(shockAmount > 0n);

console.error("STEP rise-shock-start");
const shock = await execute(
  ctx,
  {
    kind: "buy",
    amount: shockAmount,
    score: 1n,
    reason: "external fork rise shock",
  },
  true,
);
assert.equal(shock.status, "confirmed");
console.error("STEP rise-shock-confirmed");

const postShockObservation = await observe(
  ctx,
  baselineObservation.block + 1,
);
const postShockBalances = await balances(ctx);
const policyAction = decide(
  postShockObservation,
  baselineState,
  postShockBalances.weth,
  postShockBalances.token,
  ctx.tokenIs0,
);

assert.equal(
  policyAction.kind,
  "sell",
  `a large token buy should produce a countercyclical sell, got ${policyAction.kind}`,
);
console.error("STEP rise-policy-selected", policyAction.kind);

const beforePolicyExecution = await balances(ctx);
const policyExecution = await execute(ctx, policyAction, true);
const afterPolicyExecution = await balances(ctx);
assert.equal(policyExecution.status, "confirmed");
assert.ok(afterPolicyExecution.token < beforePolicyExecution.token);
assert.ok(afterPolicyExecution.weth > beforePolicyExecution.weth);
console.error("STEP rise-policy-execution-confirmed");

console.log(
  JSON.stringify(
    {
      baseline: {
        block: baselineObservation.block,
        sqrtPriceX96: baselineObservation.sqrtPriceX96.toString(),
      },
      shock: {
        action: "buy",
        amount: shockAmount.toString(),
        result: shock,
      },
      observedAfterShock: {
        block: postShockObservation.block,
        sqrtPriceX96: postShockObservation.sqrtPriceX96.toString(),
        volumeWeth: postShockObservation.volumeWeth.toString(),
        swapCount: postShockObservation.swapCount,
      },
      policyAction: {
        ...policyAction,
        amount:
          "amount" in policyAction
            ? policyAction.amount.toString()
            : undefined,
        score:
          "score" in policyAction
            ? policyAction.score.toString()
            : undefined,
      },
      policyExecution,
      policyBalanceDelta: {
        weth: (
          afterPolicyExecution.weth - beforePolicyExecution.weth
        ).toString(),
        token: (
          afterPolicyExecution.token - beforePolicyExecution.token
        ).toString(),
      },
    },
    null,
    2,
  ),
);
