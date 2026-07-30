import assert from "node:assert/strict";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  JsonRpcSigner,
} from "../aristotle-output/input_aristotle/node_modules/ethers/lib.esm/index.js";
import {
  balances,
  discover,
  simulateClaim,
} from "../aristotle-output/input_aristotle/dist/chain.js";
import {
  collect,
  execute,
} from "../aristotle-output/input_aristotle/dist/executor.js";
import {
  ABIS,
  LOCKER,
  ROUTER,
  WETH,
} from "../aristotle-output/input_aristotle/dist/constants.js";

const RPC = "http://127.0.0.1:18547";
const TOKEN = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const CREATOR = "0xFe884239Ab22cA90BB86a33120aD932bd52339F1";

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
await provider.send("anvil_setBalance", [CREATOR, "0x8ac7230489e80000"]);

await provider.send("anvil_impersonateAccount", [CREATOR]);
const signer = new JsonRpcSigner(provider, CREATOR);
const discovered = await discover(RPC, TOKEN);
const ctx = { ...discovered, signer };

assert.equal(ctx.recipient.toLowerCase(), CREATOR.toLowerCase());
assert.equal(ctx.deployer.toLowerCase(), CREATOR.toLowerCase());

const weth = new Contract(WETH, ABIS.token, provider);
const token = new Contract(ctx.token, ABIS.token, provider);
const lockerInterface = new Interface(ABIS.locker);

const initial = await balances(ctx);
const claimSimulation = await simulateClaim(ctx);
const initialClaim = await collect(ctx);
console.error("STEP initial-claim", initialClaim.status);
assert.ok(
  initialClaim.status === "confirmed" || initialClaim.status === "skipped",
);

const buyAmount =
  initial.weth / 100n < 10_000_000_000_000n
    ? initial.weth / 100n
    : 10_000_000_000_000n;
assert.ok(buyAmount > 0n);

const beforeBuy = await balances(ctx);
const buy = await execute(
  ctx,
  { kind: "buy", amount: buyAmount, score: 1n, reason: "fork buy" },
  true,
);
const afterBuy = await balances(ctx);
console.error("STEP buy", buy.status);
assert.equal(buy.status, "confirmed");
assert.equal(beforeBuy.weth - afterBuy.weth, buyAmount);
assert.ok(afterBuy.token > beforeBuy.token);
assert.equal(await weth.allowance(CREATOR, ROUTER), 0n);

const sellAmount =
  afterBuy.token / 1000n < 1_000_000_000_000_000_000_000n
    ? afterBuy.token / 1000n
    : 1_000_000_000_000_000_000_000n;
assert.ok(sellAmount > 0n);

const beforeSell = await balances(ctx);
const sell = await execute(
  ctx,
  { kind: "sell", amount: sellAmount, score: 1n, reason: "fork sell" },
  true,
);
const afterSell = await balances(ctx);
console.error("STEP sell", sell.status);
assert.equal(sell.status, "confirmed");
assert.equal(beforeSell.token - afterSell.token, sellAmount);
assert.ok(afterSell.weth > beforeSell.weth);
assert.equal(await token.allowance(CREATOR, ROUTER), 0n);

const beforeClaim = await balances(ctx);
const claim = await collect(ctx);
const afterClaim = await balances(ctx);
console.error("STEP funded-claim", claim.status);
assert.equal(claim.status, "confirmed");
assert.ok(claim.txHash);
assert.ok(
  afterClaim.weth > beforeClaim.weth || afterClaim.token > beforeClaim.token,
  "claim must increase at least one creator balance",
);

const claimReceipt = await provider.getTransactionReceipt(claim.txHash);
assert.ok(claimReceipt);
const claimedEvent = claimReceipt.logs
  .map((log) => {
    try {
      return lockerInterface.parseLog(log);
    } catch {
      return null;
    }
  })
  .find((event) => event?.name === "FeesClaimed");
assert.ok(claimedEvent, "claim receipt must include FeesClaimed");

const wethClaimDelta = afterClaim.weth - beforeClaim.weth;
const tokenClaimDelta = afterClaim.token - beforeClaim.token;
const eventWeth = ctx.tokenIs0
  ? claimedEvent.args.recipientAmount1
  : claimedEvent.args.recipientAmount0;
const eventToken = ctx.tokenIs0
  ? claimedEvent.args.recipientAmount0
  : claimedEvent.args.recipientAmount1;
assert.equal(wethClaimDelta, eventWeth);
assert.equal(tokenClaimDelta, eventToken);

const postClaimEmpty = await collect(ctx);
console.error("STEP post-claim-empty", postClaimEmpty.status);
assert.equal(postClaimEmpty.status, "skipped");
assert.match(postClaimEmpty.detail, /no fees/i);

const burnAmount =
  afterClaim.token < 1_000_000_000_000_000_000n
    ? afterClaim.token
    : 1_000_000_000_000_000_000n;
assert.ok(burnAmount > 0n);

const beforeBurn = await balances(ctx);
const burn = await execute(
  ctx,
  { kind: "burn", amount: burnAmount, score: 1n, reason: "fork burn" },
  true,
);
const afterBurn = await balances(ctx);
console.error("STEP burn", burn.status);
assert.equal(burn.status, "confirmed");
assert.equal(beforeBurn.token - afterBurn.token, burnAmount);

const excessive = await execute(
  ctx,
  {
    kind: "sell",
    amount: afterBurn.token + 1n,
    score: 1n,
    reason: "fork excessive balance",
  },
  true,
);
console.error("STEP excessive", excessive.status);
assert.equal(excessive.status, "failed");
assert.match(excessive.detail, /exceeds reconciled balance/);

console.log(
  JSON.stringify(
    {
      forkBlock: await provider.getBlockNumber(),
      creator: CREATOR,
      claimSimulation,
      initialClaim,
      claim: {
        result: claim,
        wethDelta: wethClaimDelta.toString(),
        tokenDelta: tokenClaimDelta.toString(),
        event: {
          recipientAmount0: claimedEvent.args.recipientAmount0.toString(),
          recipientAmount1: claimedEvent.args.recipientAmount1.toString(),
        },
      },
      postClaimEmpty,
      buy: {
        result: buy,
        amountIn: buyAmount.toString(),
        tokenOut: (afterBuy.token - beforeBuy.token).toString(),
        finalAllowance: (await weth.allowance(CREATOR, ROUTER)).toString(),
      },
      sell: {
        result: sell,
        amountIn: sellAmount.toString(),
        wethOut: (afterSell.weth - beforeSell.weth).toString(),
        finalAllowance: (await token.allowance(CREATOR, ROUTER)).toString(),
      },
      burn: {
        result: burn,
        amount: burnAmount.toString(),
      },
      excessive,
    },
    null,
    2,
  ),
);
