import assert from "node:assert/strict";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
} from "../aristotle-output/input_aristotle/node_modules/ethers/lib.esm/index.js";
import {
  balances,
  discover,
  observe,
} from "../aristotle-output/input_aristotle/dist/chain.js";
import {
  executePermanentLp,
  resumeAirdrop,
} from "../aristotle-output/input_aristotle/dist/executor.js";
import {
  lpRange,
} from "../aristotle-output/input_aristotle/dist/math.js";
import {
  ABIS,
  BURN,
  POSITION_MANAGER,
  WETH,
} from "../aristotle-output/input_aristotle/dist/constants.js";
import {
  makePlan,
} from "../aristotle-output/input_aristotle/dist/airdrop.js";

const RPC = "http://127.0.0.1:18547";
const TOKEN = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const CREATOR = "0xFe884239Ab22cA90BB86a33120aD932bd52339F1";
const privateKey = process.env.CREATOR_PRIVATE_KEY;
if (!privateKey) throw new Error("CREATOR_PRIVATE_KEY is required for the fork");

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
await provider.send("anvil_setBalance", [CREATOR, "0x8ac7230489e80000"]);
const ctx = await discover(RPC, TOKEN, privateKey);
assert.equal(getAddress(ctx.signer.address), getAddress(CREATOR));

const token = new Contract(TOKEN, ABIS.token, provider);
const weth = new Contract(WETH, ABIS.token, provider);
const manager = new Contract(POSITION_MANAGER, ABIS.positionManager, provider);

const observation = await observe(ctx, 0);
const beforeLp = await balances(ctx);
const [tickLower, tickUpper] = lpRange(
  observation.tick,
  observation.tickSpacing,
  2_000n,
);
const amountToken = beforeLp.token / 100n;
const amountWeth = beforeLp.weth / 100n;
assert.ok(amountToken > 0n && amountWeth > 0n);

const lpStages = [];
const lpResult = await executePermanentLp(
  ctx,
  {
    kind: "permanent_lp",
    amountToken,
    amountWeth,
    tickLower,
    tickUpper,
    score: 2_000n,
    reason: "fork v2 permanent LP",
  },
  async (stage, data) => {
    lpStages.push({ stage, ...data });
  },
);
assert.equal(lpResult.status, "confirmed", lpResult.detail);
assert.ok(lpResult.tokenId);
assert.notEqual(BigInt(lpResult.tokenId), ctx.launchPositionId);
assert.equal(
  getAddress(await manager.ownerOf(BigInt(lpResult.tokenId))),
  getAddress(BURN),
);
assert.deepEqual(
  lpStages.map((entry) => entry.stage),
  ["mint_prepared", "minted", "lock_prepared", "locked"],
);
assert.ok(lpStages[0].rawTx, "Wallet path must persist the signed mint");
assert.ok(lpStages[2].rawTx, "Wallet path must persist the signed lock");
assert.equal(await token.allowance(CREATOR, POSITION_MANAGER), 0n);
assert.equal(await weth.allowance(CREATOR, POSITION_MANAGER), 0n);
const afterLp = await balances(ctx);
assert.ok(afterLp.token < beforeLp.token);
assert.ok(afterLp.weth < beforeLp.weth);
assert.ok(beforeLp.token - afterLp.token <= amountToken);
assert.ok(beforeLp.weth - afterLp.weth <= amountWeth);

const recipients = [
  "0x1000000000000000000000000000000000000001",
  "0x2000000000000000000000000000000000000002",
  "0x3000000000000000000000000000000000000003",
];
const entries = recipients.map((address, index) => [
  getAddress(address),
  BigInt(index + 1),
]);
const total = afterLp.weth / 1_000n;
assert.ok(total > 0n);
const seed = `0x${"42".repeat(32)}`;
const cycleId = `0x${"24".repeat(32)}`;
const plan = makePlan(
  cycleId,
  observation.block,
  observation.block + 1,
  entries,
  seed,
  total,
  3,
);
const recipientBefore = new Map();
for (const recipient of plan.recipients) {
  recipientBefore.set(recipient.address, await weth.balanceOf(recipient.address));
}
const senderBefore = await weth.balanceOf(CREATOR);

let injectedCrash = true;
const firstAttempt = await resumeAirdrop(ctx, plan, async (current) => {
  if (
    injectedCrash &&
    current.recipients.some(
      (recipient) =>
        recipient.status === "submitted" &&
        recipient.txHash &&
        recipient.rawTx,
    )
  ) {
    injectedCrash = false;
    throw new Error("injected crash after durable signed payout");
  }
});
assert.equal(firstAttempt.status, "failed");
const prepared = plan.recipients.find(
  (recipient) => recipient.status === "submitted",
);
assert.ok(prepared?.txHash);
assert.ok(prepared?.rawTx);

const recovered = await resumeAirdrop(ctx, plan, async () => {});
assert.equal(recovered.status, "confirmed", recovered.detail);
assert.ok(plan.recipients.every((recipient) => recipient.status === "confirmed"));
assert.equal(senderBefore - (await weth.balanceOf(CREATOR)), total);
for (const recipient of plan.recipients) {
  assert.equal(
    (await weth.balanceOf(recipient.address)) -
      recipientBefore.get(recipient.address),
    BigInt(recipient.amount),
  );
}

const transferInterface = new Interface(ABIS.token);
const payoutHashes = plan.recipients.map((recipient) => recipient.txHash);
assert.equal(new Set(payoutHashes).size, 3);
for (const hash of payoutHashes) {
  const receipt = await provider.getTransactionReceipt(hash);
  assert.equal(receipt.status, 1);
  assert.ok(
    receipt.logs.some((log) => {
      try {
        return transferInterface.parseLog(log)?.name === "Transfer";
      } catch {
        return false;
      }
    }),
  );
}

console.log(
  JSON.stringify(
    {
      lp: {
        tokenId: lpResult.tokenId,
        txHashes: lpResult.txHashes,
        tokenSpent: (beforeLp.token - afterLp.token).toString(),
        wethSpent: (beforeLp.weth - afterLp.weth).toString(),
        owner: await manager.ownerOf(BigInt(lpResult.tokenId)),
      },
      airdrop: {
        total: total.toString(),
        recipients: plan.recipients,
        recoveredAfterInjectedCrash: true,
      },
    },
    null,
    2,
  ),
);

provider.destroy();
