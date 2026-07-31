import {
  Contract,
  Interface,
  TransactionReceipt,
  Wallet,
  getAddress,
  keccak256,
} from "ethers";
import {
  ABIS,
  BPS,
  BURN,
  LOCKER,
  POSITION_MANAGER,
  ROUTER,
  WETH,
} from "./constants.js";
import type { Context } from "./chain.js";
import type { Action } from "./math.js";
import type { AirdropPlan } from "./airdrop.js";
import { quote } from "./chain.js";
import { withNonceLock } from "./nonce-lock.js";
export interface ExecutionResult {
  status: "skipped" | "confirmed" | "failed";
  detail: string;
  txHash?: string;
  txHashes?: string[];
  tokenId?: string;
}
export interface PreparedTransaction {
  hash: string;
  nonce: number;
  rawTx?: string | undefined;
}
export type PreparedHook = (transaction: PreparedTransaction) => Promise<void>;

async function receiptOf(tx: any): Promise<TransactionReceipt> {
  try {
    const r = await tx.wait(2, 180_000);
    if (!r || r.status !== 1) throw new Error("transaction reverted");
    return r;
  } catch (e: any) {
    if (e?.replacement) {
      const r = await e.replacement.wait(2);
      if (r?.status === 1) return r;
    }
    throw e;
  }
}
export async function sendBuffered(
  contract: any,
  method: string,
  args: any[],
  onPrepared?: PreparedHook,
): Promise<TransactionReceipt> {
  const fn = contract[method];
  const runner = contract.runner;

  // Production uses an ethers Wallet. Sign first, persist the deterministic
  // hash/raw transaction, and only then broadcast. A crash can therefore
  // rebroadcast the exact same transaction instead of creating a duplicate.
  if (runner instanceof Wallet && runner.provider) {
    const from = getAddress(runner.address);
    let response: any;
    await withNonceLock(from, async () => {
      const populated = await fn.populateTransaction(...args);
      const estimate = await runner.provider!.estimateGas({
        ...populated,
        from,
      });
      const gasLimit = (estimate * 120n + 99n) / 100n;
      const [network, feeData, nonce] = await Promise.all([
        runner.provider!.getNetwork(),
        runner.provider!.getFeeData(),
        runner.provider!.getTransactionCount(from, "pending"),
      ]);
      const transaction: Record<string, unknown> = {
        ...populated,
        chainId: network.chainId,
        nonce,
        gasLimit,
      };
      if (feeData.maxFeePerGas !== null) {
        transaction.type = 2;
        transaction.maxFeePerGas = feeData.maxFeePerGas;
        transaction.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;
      } else {
        if (feeData.gasPrice === null)
          throw new Error("provider returned no transaction fee data");
        transaction.gasPrice = feeData.gasPrice;
      }
      const rawTx = await runner.signTransaction(transaction);
      const hash = keccak256(rawTx);
      await onPrepared?.({ hash, nonce, rawTx });
      response = await runner.provider!.broadcastTransaction(rawTx);
      if (response.hash !== hash)
        throw new Error("broadcast transaction hash mismatch");
    });
    return receiptOf(response);
  }

  // Fork tests use an impersonated JsonRpcSigner, which cannot export a raw
  // signed transaction. Persist immediately after eth_sendTransaction.
  const estimate: bigint = await fn.estimateGas(...args);
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const response = await fn(...args, { gasLimit });
  await onPrepared?.({ hash: response.hash, nonce: response.nonce });
  return receiptOf(response);
}

export async function settlePrepared(
  ctx: Context,
  transaction: PreparedTransaction,
): Promise<TransactionReceipt | null> {
  const known = await ctx.provider.getTransactionReceipt(transaction.hash);
  if (known) return known;

  if (transaction.rawTx) {
    await withNonceLock(ctx.signer?.address ?? ctx.recipient, async () => {
      try {
        const response = await ctx.provider.broadcastTransaction(
          transaction.rawTx!,
        );
        if (response.hash !== transaction.hash)
          throw new Error("recovery broadcast hash mismatch");
      } catch (error) {
        const text = String(error).toLowerCase();
        if (
          !text.includes("already known") &&
          !text.includes("known transaction") &&
          !text.includes("nonce has already been used")
        )
          throw error;
      }
    });
  }

  return ctx.provider.waitForTransaction(transaction.hash, 2, 180_000);
}
async function clear(
  asset: any,
  owner: string,
  spender: string,
): Promise<void> {
  const a: bigint = await asset.allowance(owner, spender);
  if (a !== 0n) await sendBuffered(asset, "approve", [spender, 0n]);
}
async function approveExact(
  asset: any,
  owner: string,
  spender: string,
  amount: bigint,
): Promise<void> {
  await clear(asset, owner, spender);
  await asset.approve.staticCall(spender, amount);
  await sendBuffered(asset, "approve", [spender, amount]);
}

export async function clearKnownAllowances(ctx: Context): Promise<void> {
  if (!ctx.signer) return;
  const token: any = new Contract(ctx.token, ABIS.token, ctx.signer);
  const weth: any = new Contract(WETH, ABIS.token, ctx.signer);
  await Promise.all([
    clear(token, ctx.signer.address, ROUTER),
    clear(weth, ctx.signer.address, ROUTER),
    clear(token, ctx.signer.address, POSITION_MANAGER),
    clear(weth, ctx.signer.address, POSITION_MANAGER),
  ]);
}
export async function collect(ctx: Context): Promise<ExecutionResult> {
  if (!ctx.signer) return { status: "skipped", detail: "non-signing mode" };
  const c: any = new Contract(LOCKER, ABIS.locker, ctx.signer);
  try {
    await c.collectFees.staticCall(ctx.token);
    const r = await sendBuffered(c, "collectFees", [ctx.token]);
    return {
      status: "confirmed",
      detail: "creator fees collected and receipt confirmed",
      txHash: r.hash,
    };
  } catch (e) {
    const s = String(e);
    if (/NoFeesToCollect|0xd0d04f60|0x6a4ea9e4/.test(s))
      return { status: "skipped", detail: "no fees currently claimable" };
    return {
      status: "failed",
      detail: `fee collection failed safely: ${s.slice(0, 240)}`,
    };
  }
}
function signingGuard(
  ctx: Context,
  kind: string,
  enabled: boolean,
): ExecutionResult | undefined {
  if (!enabled || !ctx.signer)
    return { status: "skipped", detail: `dry-run ${kind}` };
  if (getAddress(ctx.signer.address) !== getAddress(ctx.recipient))
    return {
      status: "failed",
      detail:
        "signer is not resolved fee recipient; refusing another wallet's reservoir",
    };
}
async function executeSwap(
  ctx: Context,
  action: {
    kind: "buy" | "sell";
    amount: bigint;
    score: bigint;
    reason: string;
  },
  onPrepared?: PreparedHook,
): Promise<ExecutionResult> {
  const signer = ctx.signer!,
    assetAddress = action.kind === "buy" ? WETH : ctx.token,
    outAddress = action.kind === "buy" ? ctx.token : WETH;
  const input: any = new Contract(assetAddress, ABIS.token, signer),
    output: any = new Contract(outAddress, ABIS.token, ctx.provider);
  const beforeIn: bigint = await input.balanceOf(signer.address);
  if (action.amount > beforeIn)
    return { status: "failed", detail: "amount exceeds reconciled balance" };
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const expected = await quote(ctx, action);
      if (expected <= 0n) throw new Error("zero quote");
      const minOut = (expected * (BPS - 75n)) / BPS;
      const beforeOut: bigint = await output.balanceOf(signer.address);
      await approveExact(input, signer.address, ROUTER, action.amount);
      const router: any = new Contract(ROUTER, ABIS.router, signer);
      const p = {
        tokenIn: assetAddress,
        tokenOut: outAddress,
        fee: ctx.fee,
        recipient: signer.address,
        amountIn: action.amount,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0,
      };
      await router.exactInputSingle.staticCall(p);
      const r = await sendBuffered(router, "exactInputSingle", [p], onPrepared);
      const [afterIn, afterOut] = await Promise.all([
        input.balanceOf(signer.address),
        output.balanceOf(signer.address),
      ]);
      if (beforeIn - afterIn !== action.amount || afterOut - beforeOut < minOut)
        throw new Error("swap balance reconciliation failed");
      await clear(input, signer.address, ROUTER);
      return {
        status: "confirmed",
        detail: `swap confirmed${attempt ? " after one fresh-quote retry" : ""}; received ${afterOut - beforeOut}`,
        txHash: r.hash,
      };
    } catch (e) {
      await clear(input, signer.address, ROUTER).catch(() => {});
      if (attempt === 0 && /too little|revert|quote/i.test(String(e))) continue;
      return {
        status: "failed",
        detail: `swap failed safely after ${attempt + 1} attempt(s): ${String(e).slice(0, 240)}`,
      };
    }
  return { status: "failed", detail: "unreachable swap failure" };
}
async function executeBurn(
  ctx: Context,
  action: { kind: "burn"; amount: bigint; score: bigint; reason: string },
  onPrepared?: PreparedHook,
): Promise<ExecutionResult> {
  const token: any = new Contract(ctx.token, ABIS.token, ctx.signer!);
  const before: bigint = await token.balanceOf(ctx.recipient);
  if (action.amount > before)
    return { status: "failed", detail: "amount exceeds reconciled balance" };
  try {
    await token.transfer.staticCall(BURN, action.amount);
    const r = await sendBuffered(
      token,
      "transfer",
      [BURN, action.amount],
      onPrepared,
    );
    if (before - BigInt(await token.balanceOf(ctx.recipient)) !== action.amount)
      throw new Error("burn reconciliation failed");
    return {
      status: "confirmed",
      detail: "ERC-20 burn-address transfer confirmed; totalSupply unchanged",
      txHash: r.hash,
    };
  } catch (e) {
    return {
      status: "failed",
      detail: `burn failed safely: ${String(e).slice(0, 240)}`,
    };
  }
}
export async function executePermanentLp(
  ctx: Context,
  a: Extract<Action, { kind: "permanent_lp" }>,
  progress?: (
    stage: "mint_prepared" | "minted" | "lock_prepared" | "locked",
    data: {
      tokenId?: string | undefined;
      txHash: string;
      nonce?: number | undefined;
      rawTx?: string | undefined;
    },
  ) => Promise<void>,
): Promise<ExecutionResult> {
  const signer = ctx.signer!,
    token: any = new Contract(ctx.token, ABIS.token, signer),
    weth: any = new Contract(WETH, ABIS.token, signer),
    pm: any = new Contract(POSITION_MANAGER, ABIS.positionManager, signer);
  const token0 = ctx.tokenIs0 ? ctx.token : WETH,
    token1 = ctx.tokenIs0 ? WETH : ctx.token;
  const amount0 = ctx.tokenIs0 ? a.amountToken : a.amountWeth,
    amount1 = ctx.tokenIs0 ? a.amountWeth : a.amountToken;
  try {
    const pool: any = new Contract(ctx.pool, ABIS.pool, ctx.provider);
    const liveSlot = await pool.slot0();
    const liveTick = Number(liveSlot[1]);
    if (!(a.tickLower < liveTick && liveTick < a.tickUpper))
      throw new Error("live tick moved outside the planned LP range");

    const beforeToken = BigInt(await token.balanceOf(ctx.recipient)),
      beforeWeth = BigInt(await weth.balanceOf(ctx.recipient));
    if (a.amountToken > beforeToken || a.amountWeth > beforeWeth)
      throw new Error("LP amount exceeds reconciled balance");
    await approveExact(token, ctx.recipient, POSITION_MANAGER, a.amountToken);
    await approveExact(weth, ctx.recipient, POSITION_MANAGER, a.amountWeth);
    const base = {
      token0,
      token1,
      fee: ctx.fee,
      tickLower: a.tickLower,
      tickUpper: a.tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      recipient: ctx.recipient,
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    // V3 consumes assets in the ratio implied by the live price and range.
    // Preview the exact pair instead of incorrectly requiring 99% of both
    // wallet allocations to be consumed.
    const preview = await pm.mint.staticCall({
      ...base,
      amount0Min: 0n,
      amount1Min: 0n,
    });
    const expected0 = BigInt(preview.amount0 ?? preview[2]);
    const expected1 = BigInt(preview.amount1 ?? preview[3]);
    if (expected0 <= 0n || expected1 <= 0n)
      throw new Error("LP preview is not dual-sided at the live tick");
    const p = {
      ...base,
      amount0Min: (expected0 * 99n) / 100n,
      amount1Min: (expected1 * 99n) / 100n,
    };
    await pm.mint.staticCall(p);
    const mint = await sendBuffered(pm, "mint", [p], async (transaction) => {
      await progress?.("mint_prepared", {
        txHash: transaction.hash,
        nonce: transaction.nonce,
        rawTx: transaction.rawTx,
      });
    });
    const pi = new Interface(ABIS.positionManager);
    let tokenId: bigint | undefined,
      used0: bigint | undefined,
      used1: bigint | undefined;
    for (const log of mint.logs)
      try {
        const e = pi.parseLog(log);
        if (e?.name === "IncreaseLiquidity") {
          used0 = BigInt(e.args.amount0);
          used1 = BigInt(e.args.amount1);
        }
        if (
          e?.name === "Transfer" &&
          getAddress(e.args.from) ===
            getAddress("0x0000000000000000000000000000000000000000")
        )
          tokenId = e.args.tokenId;
      } catch {}
    if (tokenId === undefined || used0 === undefined || used1 === undefined)
      throw new Error("mint result events incomplete");
    const usedToken = ctx.tokenIs0 ? used0 : used1,
      usedWeth = ctx.tokenIs0 ? used1 : used0;
    if (
      used0 < p.amount0Min ||
      used1 < p.amount1Min ||
      used0 > amount0 ||
      used1 > amount1 ||
      beforeToken - BigInt(await token.balanceOf(ctx.recipient)) !==
        usedToken ||
      beforeWeth - BigInt(await weth.balanceOf(ctx.recipient)) !== usedWeth
    )
      throw new Error("LP balance/amount reconciliation failed");
    if (tokenId === ctx.launchPositionId)
      throw new Error("refusing original launch position");
    if (progress)
      await progress("minted", {
        tokenId: tokenId.toString(),
        txHash: mint.hash,
      });
    const pos = await pm.positions(tokenId);
    if (
      getAddress(pos[2]) !== getAddress(token0) ||
      getAddress(pos[3]) !== getAddress(token1) ||
      Number(pos[4]) !== ctx.fee ||
      Number(pos[5]) !== a.tickLower ||
      Number(pos[6]) !== a.tickUpper ||
      BigInt(pos[7]) === 0n ||
      getAddress(await pm.ownerOf(tokenId)) !== getAddress(ctx.recipient)
    )
      throw new Error("minted position verification failed");
    await pm.transferFrom.staticCall(ctx.recipient, BURN, tokenId);
    const lock = await sendBuffered(
      pm,
      "transferFrom",
      [ctx.recipient, BURN, tokenId],
      async (transaction) => {
        await progress?.("lock_prepared", {
          tokenId: tokenId.toString(),
          txHash: transaction.hash,
          nonce: transaction.nonce,
          rawTx: transaction.rawTx,
        });
      },
    );
    if (getAddress(await pm.ownerOf(tokenId)) !== getAddress(BURN))
      throw new Error("permanent lock ownership failed");
    if (progress)
      await progress("locked", {
        tokenId: tokenId.toString(),
        txHash: lock.hash,
      });
    await clear(token, ctx.recipient, POSITION_MANAGER);
    await clear(weth, ctx.recipient, POSITION_MANAGER);
    return {
      status: "confirmed",
      detail:
        "new canonical-pool position minted, verified, and irreversibly transferred",
      txHashes: [mint.hash, lock.hash],
      tokenId: tokenId.toString(),
    };
  } catch (e) {
    await Promise.all([
      clear(token, ctx.recipient, POSITION_MANAGER).catch(() => {}),
      clear(weth, ctx.recipient, POSITION_MANAGER).catch(() => {}),
    ]);
    return {
      status: "failed",
      detail: `permanent LP failed safely: ${String(e).slice(0, 240)}`,
    };
  }
}
export async function resumePermanentLpLock(
  ctx: Context,
  tokenId: bigint,
  onPrepared?: PreparedHook,
): Promise<ExecutionResult> {
  const pm: any = new Contract(
    POSITION_MANAGER,
    ABIS.positionManager,
    ctx.signer!,
  );
  try {
    const owner = getAddress(await pm.ownerOf(tokenId));
    if (owner === getAddress(BURN))
      return {
        status: "confirmed",
        detail: "permanent LP lock already confirmed",
        tokenId: tokenId.toString(),
      };
    if (owner !== getAddress(ctx.recipient))
      throw new Error("minted NFT has unexpected owner");
    if (tokenId === ctx.launchPositionId)
      throw new Error("refusing original launch position");
    const r = await sendBuffered(
      pm,
      "transferFrom",
      [ctx.recipient, BURN, tokenId],
      onPrepared,
    );
    if (getAddress(await pm.ownerOf(tokenId)) !== getAddress(BURN))
      throw new Error("lock reconciliation failed");
    return {
      status: "confirmed",
      detail: "interrupted LP plan resumed and permanently locked",
      txHash: r.hash,
      tokenId: tokenId.toString(),
    };
  } catch (e) {
    return {
      status: "failed",
      detail: `LP lock recovery failed safely: ${String(e).slice(0, 240)}`,
    };
  }
}

export async function verifyPermanentLpPosition(
  ctx: Context,
  tokenId: bigint,
  action: Extract<Action, { kind: "permanent_lp" }>,
): Promise<void> {
  const pm: any = new Contract(
    POSITION_MANAGER,
    ABIS.positionManager,
    ctx.provider,
  );
  if (tokenId === ctx.launchPositionId)
    throw new Error("refusing original launch position");
  const token0 = ctx.tokenIs0 ? ctx.token : WETH;
  const token1 = ctx.tokenIs0 ? WETH : ctx.token;
  const position = await pm.positions(tokenId);
  if (
    getAddress(position[2]) !== getAddress(token0) ||
    getAddress(position[3]) !== getAddress(token1) ||
    Number(position[4]) !== ctx.fee ||
    Number(position[5]) !== action.tickLower ||
    Number(position[6]) !== action.tickUpper ||
    BigInt(position[7]) === 0n
  )
    throw new Error("minted position verification failed");
}
export async function resumeAirdrop(
  ctx: Context,
  plan: AirdropPlan,
  persist: (p: AirdropPlan) => Promise<void>,
): Promise<ExecutionResult> {
  const weth: any = new Contract(WETH, ABIS.token, ctx.signer!);
  const transferInterface = new Interface(ABIS.token);
  const hashes: string[] = [];
  try {
    for (const item of plan.recipients) {
      if (item.status === "confirmed") continue;
      if (item.status === "failed")
        throw new Error(
          `payout ${item.address} is failed and requires operator review`,
        );
      const amount = BigInt(item.amount);
      let receipt: TransactionReceipt;

      if (item.status === "submitted") {
        if (!item.txHash)
          throw new Error(
            "submitted payout has no hash; refusing a possible duplicate",
          );
        const recovered = await settlePrepared(ctx, {
          hash: item.txHash,
          nonce: item.nonce ?? 0,
          rawTx: item.rawTx,
        });
        if (!recovered) throw new Error("submitted payout remains pending");
        receipt = recovered;
      } else {
        const beforeTo: bigint = await weth.balanceOf(item.address);
        const beforeFrom: bigint = await weth.balanceOf(ctx.recipient);
        item.senderBefore = beforeFrom.toString();
        item.recipientBefore = beforeTo.toString();
        await persist(plan);
        receipt = await sendBuffered(
          weth,
          "transfer",
          [item.address, amount],
          async (transaction) => {
            item.status = "submitted";
            item.txHash = transaction.hash;
            item.rawTx = transaction.rawTx;
            item.nonce = transaction.nonce;
            await persist(plan);
          },
        );
      }

      if (receipt.status !== 1) {
        item.status = "failed";
        await persist(plan);
        throw new Error("payout transaction reverted");
      }
      const transfer = receipt.logs
        .filter((log) => getAddress(log.address) === getAddress(WETH))
        .map((log) => {
          try {
            return transferInterface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find(
          (event) =>
            event?.name === "Transfer" &&
            getAddress(event.args.from) === getAddress(ctx.recipient) &&
            getAddress(event.args.to) === getAddress(item.address) &&
            BigInt(event.args.value) === amount,
        );
      if (!transfer) {
        item.status = "failed";
        await persist(plan);
        throw new Error("payout receipt transfer reconciliation failed");
      }

      item.txHash = receipt.hash;
      item.receiptBlock = receipt.blockNumber;
      item.status = "confirmed";
      hashes.push(receipt.hash);
      await persist(plan);
    }
    return {
      status: "confirmed",
      detail: "all unique WETH payouts confirmed and reconciled",
      txHashes: hashes,
    };
  } catch (e) {
    return {
      status: "failed",
      detail: `airdrop paused safely: ${String(e).slice(0, 240)}`,
      txHashes: hashes,
    };
  }
}
export async function execute(
  ctx: Context,
  action: Action,
  enabled: boolean,
  onPrepared?: PreparedHook,
): Promise<ExecutionResult> {
  if (action.kind === "hold")
    return { status: "skipped", detail: action.reason };
  const g = signingGuard(ctx, action.kind, enabled);
  if (g)
    return action.kind === "buy" || action.kind === "sell"
      ? { ...g, detail: `${g.detail} ${action.amount}` }
      : g;
  if (action.kind === "buy" || action.kind === "sell")
    return executeSwap(ctx, action, onPrepared);
  if (action.kind === "burn") return executeBurn(ctx, action, onPrepared);
  if (action.kind === "permanent_lp") return executePermanentLp(ctx, action);
  return {
    status: "failed",
    detail: "airdrop requires a precommitted persisted payout plan",
  };
}
