import "dotenv/config";
import { randomBytes } from "node:crypto";
import {
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  type TransactionReceipt,
} from "ethers";
import {
  balances,
  discover,
  findDeploymentBlock,
  observe,
  simulateClaim,
  validateDeploymentBlock,
} from "./chain.js";
import { ABIS, BURN, POSITION_MANAGER, RPC_DEFAULT } from "./constants.js";
import {
  collect,
  clearKnownAllowances,
  execute,
  executePermanentLp,
  resumeAirdrop,
  resumePermanentLpLock,
  settlePrepared,
  verifyPermanentLpPosition,
  type ExecutionResult,
  type PreparedTransaction,
} from "./executor.js";
import { decide, nextDelayMs, type Action, type State } from "./math.js";
import {
  Store,
  tokenDataDir,
  type CycleJournal,
  type LpPlan,
  type PendingTransaction,
} from "./store.js";
import {
  deriveSeed,
  eligibleCommitment,
  eligibleHolders,
  makePlan,
  syncHolderIndex,
} from "./airdrop.js";
import { ensureGasReserve } from "./gas.js";

const token = process.env.TOKEN_ADDRESS;
if (!token) throw new Error("TOKEN_ADDRESS is required");

const rpc = process.env.RPC_URL || RPC_DEFAULT;
const once = process.argv.includes("--once");
const signingRequested = process.env.SIGNING_ENABLED === "true";
const privateKey = signingRequested
  ? process.env.CREATOR_PRIVATE_KEY
  : undefined;
if (signingRequested && !privateKey)
  throw new Error("CREATOR_PRIVATE_KEY is required when signing is enabled");

const store = new Store(tokenDataDir(process.env.DATA_ROOT || "./data", token));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let launchBlockPromise: Promise<number> | undefined;

type Context = Awaited<ReturnType<typeof discover>>;

function serializeAction(action: Action): unknown {
  return JSON.parse(
    JSON.stringify(action, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

async function resolveLaunchBlock(ctx: Context): Promise<number> {
  launchBlockPromise ??= (async () => {
    const configured = process.env.TOKEN_LAUNCH_BLOCK;
    if (configured)
      return validateDeploymentBlock(
        ctx.provider,
        ctx.token,
        Number(configured),
      );
    return findDeploymentBlock(ctx.provider, ctx.token);
  })();
  return launchBlockPromise;
}

async function savePrepared(
  journal: CycleJournal,
  phase: PendingTransaction["phase"],
  transaction: PreparedTransaction,
): Promise<void> {
  journal.pending = { phase, ...transaction };
  if (!journal.txHashes.includes(transaction.hash))
    journal.txHashes.push(transaction.hash);
  journal.updatedAt = Date.now();
  await store.saveJournal(journal);
}

function mintedTokenId(receipt: TransactionReceipt): bigint {
  const positionInterface = new Interface(ABIS.positionManager);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(POSITION_MANAGER)) continue;
    try {
      const event = positionInterface.parseLog(log);
      if (
        event?.name === "Transfer" &&
        getAddress(event.args.from) === getAddress(ZeroAddress)
      )
        return BigInt(event.args.tokenId);
    } catch {
      // Ignore unrelated position-manager events.
    }
  }
  throw new Error("mint receipt did not contain the new position tokenId");
}

async function recoverLp(
  ctx: Context,
  enabled: boolean,
): Promise<LpPlan | undefined> {
  let plan = await store.lpPlan();
  if (!plan || !enabled) return plan;

  if (plan.stage === "mint_prepared" && plan.mintTxHash) {
    const receipt = await settlePrepared(ctx, {
      hash: plan.mintTxHash,
      nonce: plan.mintNonce ?? 0,
      rawTx: plan.mintRawTx,
    });
    if (!receipt) throw new Error("LP mint remains pending");
    if (receipt.status !== 1) {
      plan.stage = "failed";
      plan.error = "LP mint transaction reverted";
      await store.saveLpPlan(plan);
      return plan;
    }
    plan.tokenId = mintedTokenId(receipt).toString();
    plan.stage = "minted";
    await store.saveLpPlan(plan);
  }

  if (plan.stage === "minted" && plan.tokenId) {
    const action: Extract<Action, { kind: "permanent_lp" }> = {
      ...plan.action,
      amountToken: BigInt(plan.action.amountToken),
      amountWeth: BigInt(plan.action.amountWeth),
      score: BigInt(plan.action.score),
    };
    await verifyPermanentLpPosition(ctx, BigInt(plan.tokenId), action);
    const result = await resumePermanentLpLock(
      ctx,
      BigInt(plan.tokenId),
      async (transaction) => {
        plan = {
          ...plan!,
          stage: "lock_prepared",
          lockTxHash: transaction.hash,
          lockRawTx: transaction.rawTx,
          lockNonce: transaction.nonce,
        };
        await store.saveLpPlan(plan!);
      },
    );
    if (result.status === "confirmed") {
      plan.stage = "locked";
      if (result.txHash) plan.lockTxHash = result.txHash;
      await store.saveLpPlan(plan);
    }
    console.log("LP recovery", result);
  }

  if (plan.stage === "lock_prepared" && plan.tokenId && plan.lockTxHash) {
    const receipt = await settlePrepared(ctx, {
      hash: plan.lockTxHash,
      nonce: plan.lockNonce ?? 0,
      rawTx: plan.lockRawTx,
    });
    if (!receipt) throw new Error("LP lock remains pending");
    if (receipt.status !== 1) {
      plan.stage = "failed";
      plan.error = "LP lock transaction reverted";
      await store.saveLpPlan(plan);
      return plan;
    }
    const manager: any = new Contract(
      POSITION_MANAGER,
      ABIS.positionManager,
      ctx.provider,
    );
    if (
      getAddress(await manager.ownerOf(BigInt(plan.tokenId))) !==
      getAddress(BURN)
    )
      throw new Error(
        "LP lock receipt confirmed without burn-address ownership",
      );
    plan.stage = "locked";
    await store.saveLpPlan(plan);
  }

  return plan;
}

async function recoverAirdrop(ctx: Context, enabled: boolean) {
  let plan = await store.plan();
  if (!plan || !enabled) return plan;

  if (plan.recipients.length === 0 && plan.recipientCount) {
    const launchBlock = await resolveLaunchBlock(ctx);
    let index = await store.index(launchBlock);
    if (index.completeThrough < plan.snapshotBlock) {
      index = await syncHolderIndex(
        ctx.provider,
        ctx.token,
        index,
        plan.snapshotBlock,
      );
      await store.saveIndex(index);
    }
    const entries = await eligibleHolders(ctx, index, plan.snapshotBlock);
    if (eligibleCommitment(entries) !== plan.eligibleSetHash)
      throw new Error("airdrop recovery eligible commitment mismatch");
    while ((await ctx.provider.getBlockNumber()) < plan.anchorBlock + 12)
      await sleep(2_000);
    const seed = await deriveSeed(ctx, plan);
    plan = makePlan(
      plan.cycleId,
      plan.snapshotBlock,
      plan.anchorBlock,
      entries,
      seed,
      BigInt(plan.totalWeth),
      plan.recipientCount,
    );
    await store.savePlan(plan);
  }

  if (plan.recipients.some((recipient) => recipient.status !== "confirmed")) {
    const result = await resumeAirdrop(ctx, plan, (next) =>
      store.savePlan(next),
    );
    console.log("airdrop recovery", result);
  }
  return plan;
}

async function recoverSimpleJournal(
  ctx: Context,
  journal: CycleJournal,
): Promise<void> {
  if (!journal.pending) {
    journal.stage = "failed";
    journal.resultDetail =
      "process stopped before an economic transaction was prepared";
    journal.updatedAt = Date.now();
    await store.saveJournal(journal);
    return;
  }
  if (journal.pending.phase !== "swap" && journal.pending.phase !== "burn")
    return;

  const receipt = await settlePrepared(ctx, journal.pending);
  if (!receipt) throw new Error(`cycle ${journal.cycleId} remains pending`);
  journal.stage = receipt.status === 1 ? "confirmed" : "failed";
  journal.resultDetail =
    receipt.status === 1
      ? "recovered confirmed transaction after restart"
      : "recovered reverted transaction after restart";
  journal.pending = undefined;
  journal.updatedAt = Date.now();
  await store.saveJournal(journal);
}

async function recover(ctx: Context, enabled: boolean): Promise<void> {
  if (!enabled) return;

  const lp = await recoverLp(ctx, enabled);
  const airdrop = await recoverAirdrop(ctx, enabled);
  const journal = await store.journal();
  if (!journal || journal.stage !== "executing") {
    await clearKnownAllowances(ctx);
    return;
  }

  const kind = (journal.action as { kind?: string })?.kind;
  if (kind === "permanent_lp") {
    if (lp?.stage === "locked") {
      journal.stage = "confirmed";
      journal.pending = undefined;
      journal.resultDetail = "permanent LP recovered and locked";
      journal.updatedAt = Date.now();
      await store.saveJournal(journal);
      await clearKnownAllowances(ctx);
      return;
    }
    if (lp?.stage === "failed") {
      journal.stage = "failed";
      journal.pending = undefined;
      journal.resultDetail = lp.error ?? "permanent LP recovery failed";
      journal.updatedAt = Date.now();
      await store.saveJournal(journal);
      await clearKnownAllowances(ctx);
      return;
    }
    throw new Error(`LP cycle ${journal.cycleId} remains incomplete`);
  }

  if (kind === "weth_airdrop") {
    if (
      airdrop?.cycleId === journal.cycleId &&
      airdrop.recipients.length > 0 &&
      airdrop.recipients.every((recipient) => recipient.status === "confirmed")
    ) {
      journal.stage = "confirmed";
      journal.pending = undefined;
      journal.resultDetail = "airdrop recovered with every payout confirmed";
      journal.updatedAt = Date.now();
      await store.saveJournal(journal);
      await clearKnownAllowances(ctx);
      return;
    }
    throw new Error(`airdrop cycle ${journal.cycleId} remains incomplete`);
  }

  await recoverSimpleJournal(ctx, journal);
  await clearKnownAllowances(ctx);
}

function scheduledState(
  previous: State,
  ctx: Context,
  observation: Awaited<ReturnType<typeof observe>>,
  reservoir: Awaited<ReturnType<typeof balances>>,
  cycleId: string,
  holderCursor: number,
  nextRunAt: number,
): State {
  return {
    ...previous,
    token: ctx.token,
    lastBlock: observation.block,
    lastTimestamp: observation.timestamp,
    lastSqrtPriceX96: observation.sqrtPriceX96.toString(),
    reserveWeth: reservoir.weth.toString(),
    reserveToken: reservoir.token.toString(),
    flowIntegral: (
      BigInt(previous.flowIntegral) + observation.volumeWeth
    ).toString(),
    nextRunAt,
    cycleSeq: previous.cycleSeq + 1,
    activeCycleId: cycleId,
    holderCursor,
  };
}

async function cycle(): Promise<void> {
  const ctx = await discover(rpc, token!, privateKey);
  try {
    const enabled = signingRequested && Boolean(ctx.signer);
    if (
      enabled &&
      getAddress(ctx.signer!.address) !== getAddress(ctx.recipient)
    )
      throw new Error(
        "signer is not the resolved PONS fee recipient; signing refused",
      );

    await recover(ctx, enabled);
    const gasMaintenance = await ensureGasReserve(ctx, store, enabled);
    if (gasMaintenance.status === "confirmed")
      console.log("gas maintenance", gasMaintenance);
    let state = await store.state(ctx.token);
    const existing = await store.journal();
    if (existing?.stage === "executing")
      throw new Error(
        `cycle ${existing.cycleId} is still executing; overlap refused`,
      );

    const [observation, initialBalances, claimSimulation] = await Promise.all([
      observe(ctx, state.lastBlock + 1),
      balances(ctx),
      simulateClaim(ctx),
    ]);

    const launchBlock = await resolveLaunchBlock(ctx);
    let index = await store.index(launchBlock);
    const finalized = Math.max(launchBlock - 1, observation.block - 12);
    if (index.cursor < finalized) {
      try {
        index = await syncHolderIndex(
          ctx.provider,
          ctx.token,
          index,
          Math.min(finalized, index.cursor + 1_500),
        );
        await store.saveIndex(index);
      } catch (error) {
        console.warn("holder index sync deferred", String(error));
      }
    }

    let reservoir = initialBalances;
    if (enabled) {
      const collection = await collect(ctx);
      console.log("collection", collection);
      if (collection.status === "confirmed") reservoir = await balances(ctx);
    }

    const entries =
      index.completeThrough >= finalized
        ? await eligibleHolders(ctx, index, finalized).catch((error) => {
            console.warn("holder eligibility deferred", String(error));
            return [];
          })
        : [];
    const action = decide(
      observation,
      state,
      reservoir.weth,
      reservoir.token,
      ctx.tokenIs0,
      {
        holderCount: entries.length,
        holderIndexComplete:
          index.completeThrough >= finalized && entries.length > 0,
      },
    );
    const cycleId = "0x" + randomBytes(32).toString("hex");
    const journal: CycleJournal = {
      cycleId,
      block: observation.block,
      action: serializeAction(action),
      stage: "planned",
      txHashes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.saveJournal(journal);

    const delay = nextDelayMs();
    const nextRunAt = Date.now() + delay;
    state = scheduledState(
      state,
      ctx,
      observation,
      reservoir,
      cycleId,
      index.cursor,
      nextRunAt,
    );
    await store.saveState(state);

    console.log(
      JSON.stringify(
        {
          mode: enabled ? "signing" : "dry-run",
          cycleId,
          token: ctx.token,
          pool: ctx.pool,
          feeRecipient: ctx.recipient,
          launchBlock,
          nextRunAt,
          observation: {
            ...observation,
            sqrtPriceX96: observation.sqrtPriceX96.toString(),
            liquidity: observation.liquidity.toString(),
            volumeWeth: observation.volumeWeth.toString(),
          },
          balances: {
            weth: reservoir.weth.toString(),
            token: reservoir.token.toString(),
          },
          feeClaimSimulation: claimSimulation,
          holderIndex: {
            cursor: index.cursor,
            completeThrough: index.completeThrough,
            target: finalized,
            eligibleCount: entries.length,
          },
          decision: serializeAction(action),
        },
        null,
        2,
      ),
    );

    let result: ExecutionResult = {
      status: "skipped",
      detail: enabled ? action.reason : `dry-run ${action.kind}`,
    };
    if (enabled) {
      journal.stage = "executing";
      journal.updatedAt = Date.now();
      await store.saveJournal(journal);

      if (action.kind === "weth_airdrop") {
        const anchorBlock = observation.block + 3;
        const eligibleSetHash = eligibleCommitment(entries);
        const skeleton = {
          version: 1 as const,
          cycleId,
          snapshotBlock: finalized,
          anchorBlock,
          eligibleSetHash,
          totalWeth: action.total.toString(),
          recipientCount: action.recipientCount,
        };
        await store.savePlan({ ...skeleton, recipients: [] });
        while ((await ctx.provider.getBlockNumber()) < anchorBlock + 12)
          await sleep(2_000);
        const seed = await deriveSeed(ctx, skeleton);
        const plan = makePlan(
          cycleId,
          finalized,
          anchorBlock,
          entries,
          seed,
          action.total,
          action.recipientCount,
        );
        await store.savePlan(plan);
        result = await resumeAirdrop(ctx, plan, (next) => store.savePlan(next));
      } else if (action.kind === "permanent_lp") {
        let lpPlan: LpPlan = {
          cycleId,
          stage: "planned",
          action: {
            ...action,
            amountToken: action.amountToken.toString(),
            amountWeth: action.amountWeth.toString(),
            score: action.score.toString(),
          },
        };
        await store.saveLpPlan(lpPlan);
        result = await executePermanentLp(ctx, action, async (stage, data) => {
          if (stage === "mint_prepared") {
            lpPlan = {
              ...lpPlan,
              stage,
              mintTxHash: data.txHash,
              mintRawTx: data.rawTx,
              mintNonce: data.nonce,
            };
            await savePrepared(journal, "lp_mint", {
              hash: data.txHash,
              nonce: data.nonce ?? 0,
              rawTx: data.rawTx,
            });
          } else if (stage === "minted") {
            lpPlan = {
              ...lpPlan,
              stage,
              tokenId: data.tokenId,
              mintTxHash: data.txHash,
            };
          } else if (stage === "lock_prepared") {
            lpPlan = {
              ...lpPlan,
              stage,
              tokenId: data.tokenId,
              lockTxHash: data.txHash,
              lockRawTx: data.rawTx,
              lockNonce: data.nonce,
            };
            await savePrepared(journal, "lp_lock", {
              hash: data.txHash,
              nonce: data.nonce ?? 0,
              rawTx: data.rawTx,
            });
          } else {
            lpPlan = {
              ...lpPlan,
              stage,
              tokenId: data.tokenId,
              lockTxHash: data.txHash,
            };
          }
          await store.saveLpPlan(lpPlan);
        });
      } else {
        const phase = action.kind === "burn" ? "burn" : "swap";
        result = await execute(ctx, action, true, (transaction) =>
          savePrepared(journal, phase, transaction),
        );
      }

      const recoverablePlan =
        action.kind === "permanent_lp" || action.kind === "weth_airdrop";
      if (
        result.status === "confirmed" ||
        (result.status === "skipped" && action.kind === "hold")
      ) {
        journal.stage = "confirmed";
        journal.pending = undefined;
      } else if (journal.pending || recoverablePlan) {
        journal.stage = "executing";
      } else {
        journal.stage = "failed";
      }
      journal.resultDetail = result.detail;
      journal.txHashes = Array.from(
        new Set([
          ...journal.txHashes,
          ...(result.txHashes ?? []),
          ...(result.txHash ? [result.txHash] : []),
        ]),
      );
      journal.updatedAt = Date.now();
      await store.saveJournal(journal);
      console.log("execution", result);

      if (result.status === "confirmed") {
        reservoir = await balances(ctx);
        state = {
          ...state,
          reserveWeth: reservoir.weth.toString(),
          reserveToken: reservoir.token.toString(),
          lastActionAt: Date.now(),
        };
        await store.saveState(state);
      }
    }

    console.log(`next cycle in ${(delay / 60_000).toFixed(2)} minutes`);
  } finally {
    ctx.provider.destroy();
  }
}

async function main() {
  for (;;) {
    const state = await store.state(token!);
    const wait = Math.max(0, state.nextRunAt - Date.now());
    if (wait > 0) {
      console.log(
        `honoring persisted schedule; next cycle in ${(wait / 60_000).toFixed(2)} minutes`,
      );
      await sleep(wait);
    }
    try {
      await cycle();
    } catch (error) {
      console.error("cycle failed safely; future cycles continue", error);
      await sleep(60_000);
    }
    if (once) break;
  }
}

await main();
