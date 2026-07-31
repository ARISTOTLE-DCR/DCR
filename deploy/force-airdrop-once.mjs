import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { balances, discover, observe } from "../aristotle-output/input_aristotle/dist/chain.js";
import { resumeAirdrop } from "../aristotle-output/input_aristotle/dist/executor.js";
import { nextDelayMs } from "../aristotle-output/input_aristotle/dist/math.js";
import {
  Store,
  tokenDataDir
} from "../aristotle-output/input_aristotle/dist/store.js";
import {
  deriveSeed,
  eligibleCommitment,
  eligibleHolders,
  makePlan,
  syncHolderIndex
} from "../aristotle-output/input_aristotle/dist/airdrop.js";

const token = process.env.TOKEN_ADDRESS;
const rpc = process.env.RPC_URL;
const privateKey = process.env.CREATOR_PRIVATE_KEY;
const launchBlock = Number(process.env.TOKEN_LAUNCH_BLOCK);
if (!token || !rpc || !privateKey || !Number.isInteger(launchBlock)) {
  throw new Error(
    "TOKEN_ADDRESS, RPC_URL, CREATOR_PRIVATE_KEY and TOKEN_LAUNCH_BLOCK are required"
  );
}

const dataRoot = process.env.DATA_ROOT || "./data";
const observerEvents = process.env.OBSERVER_EVENTS_FILE;
const store = new Store(tokenDataDir(dataRoot, token));
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function publish(eventType, payload) {
  if (!observerEvents) return;
  await appendFile(
    observerEvents,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      eventType,
      payload
    })}\n`,
    "utf8"
  );
}

function serialize(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  );
}

function recipientCount(total, eligibleCount) {
  const scaled = total / 10_000_000_000_000_000n;
  const bounded = scaled < 1n ? 1n : scaled > 10n ? 10n : scaled;
  return Math.min(10, eligibleCount, Number(bounded));
}

const context = await discover(rpc, token, privateKey);
try {
  if (!context.signer) throw new Error("signer unavailable");
  if (
    context.signer.address.toLowerCase() !== context.recipient.toLowerCase()
  ) {
    throw new Error("signer is not the resolved PONS fee recipient");
  }

  let index = await store.index(launchBlock);
  const syncTo = async (target) => {
    while (index.cursor < target) {
      index = await syncHolderIndex(
        context.provider,
        context.token,
        index,
        Math.min(target, index.cursor + 1_500)
      );
      await store.saveIndex(index);
      if ((index.cursor - launchBlock + 1) % 15_000 === 0) {
        console.log(`holder index ${index.cursor}/${target}`);
      }
    }
  };

  const initialTarget = Math.max(
    launchBlock - 1,
    (await context.provider.getBlockNumber()) - 12
  );
  await syncTo(initialTarget);

  const initialState = await store.state(context.token);
  const wait = Math.max(0, initialState.nextRunAt - Date.now());
  if (wait > 0) {
    console.log(
      `waiting ${(wait / 60_000).toFixed(2)} minutes for replaced cycle`
    );
    await sleep(wait);
  }

  const state = await store.state(context.token);
  const existing = await store.journal();
  if (existing?.stage === "executing") {
    throw new Error(`cycle ${existing.cycleId} is still executing`);
  }

  const [observation, reservoir] = await Promise.all([
    observe(context, state.lastBlock + 1),
    balances(context)
  ]);
  const snapshotBlock = observation.block - 12;
  await syncTo(snapshotBlock);
  const entries = await eligibleHolders(context, index, snapshotBlock);
  if (entries.length === 0) {
    throw new Error("no eligible finalized holders");
  }

  const total = (reservoir.weth * 625n) / 10_000n;
  const count = recipientCount(total, entries.length);
  if (total <= 0n || count <= 0) {
    throw new Error("airdrop allocation rounds to zero");
  }
  const cycleId = `0x${randomBytes(32).toString("hex")}`;
  const action = {
    kind: "weth_airdrop",
    total,
    recipientCount: count,
    snapshotBlock,
    score: total,
    reason:
      "operator-scheduled one-cycle override: distribute the DCR v2 maximum WETH allocation to finalized holders"
  };
  const now = Date.now();
  const journal = {
    cycleId,
    block: observation.block,
    action: serialize(action),
    stage: "planned",
    txHashes: [],
    createdAt: now,
    updatedAt: now
  };
  await store.saveJournal(journal);

  const delay = nextDelayMs();
  const nextRunAt = Date.now() + delay;
  await store.saveState({
    ...state,
    token: context.token,
    lastBlock: observation.block,
    lastTimestamp: observation.timestamp,
    lastSqrtPriceX96: observation.sqrtPriceX96.toString(),
    reserveWeth: reservoir.weth.toString(),
    reserveToken: reservoir.token.toString(),
    flowIntegral: (
      BigInt(state.flowIntegral) + observation.volumeWeth
    ).toString(),
    nextRunAt,
    cycleSeq: state.cycleSeq + 1,
    activeCycleId: cycleId,
    holderCursor: index.cursor
  });

  const anchorBlock = observation.block + 3;
  const skeleton = {
    version: 1,
    cycleId,
    snapshotBlock,
    anchorBlock,
    eligibleSetHash: eligibleCommitment(entries),
    totalWeth: total.toString(),
    recipientCount: count
  };
  await store.savePlan({ ...skeleton, recipients: [] });
  journal.stage = "executing";
  journal.updatedAt = Date.now();
  await store.saveJournal(journal);

  await publish("cycle", {
    mode: "signing",
    source: "operator-scheduled-transparent-override",
    cycleId,
    token: context.token,
    pool: context.pool,
    feeRecipient: context.recipient,
    nextRunAt,
    observation: serialize(observation),
    balances: {
      weth: reservoir.weth.toString(),
      token: reservoir.token.toString()
    },
    holderIndex: {
      cursor: index.cursor,
      completeThrough: index.completeThrough,
      target: snapshotBlock,
      eligibleCount: entries.length
    },
    decision: serialize(action)
  });

  while ((await context.provider.getBlockNumber()) < anchorBlock + 12) {
    await sleep(1_000);
  }
  const seed = await deriveSeed(context, skeleton);
  const plan = makePlan(
    cycleId,
    snapshotBlock,
    anchorBlock,
    entries,
    seed,
    total,
    count
  );
  await store.savePlan(plan);
  const result = await resumeAirdrop(context, plan, (next) =>
    store.savePlan(next)
  );

  journal.resultDetail = result.detail;
  journal.txHashes = Array.from(new Set(result.txHashes ?? []));
  journal.updatedAt = Date.now();
  if (result.status === "confirmed") {
    journal.stage = "confirmed";
    journal.pending = undefined;
  } else {
    journal.stage = "executing";
  }
  await store.saveJournal(journal);

  if (result.status === "confirmed") {
    const after = await balances(context);
    const current = await store.state(context.token);
    await store.saveState({
      ...current,
      reserveWeth: after.weth.toString(),
      reserveToken: after.token.toString(),
      lastActionAt: Date.now()
    });
  }

  for (const txHash of result.txHashes ?? []) {
    await publish("execution", {
      status: "confirmed",
      detail: "operator-scheduled WETH holder payout confirmed",
      txHash,
      source: "operator-scheduled-transparent-override",
      cycleId
    });
  }
  if (!(result.txHashes?.length)) {
    await publish("execution", {
      ...result,
      source: "operator-scheduled-transparent-override",
      action: serialize(action),
      cycleId
    });
  }
  await publish("schedule", {
    line: `next cycle in ${(delay / 60_000).toFixed(2)} minutes`,
    delayMs: delay,
    nextRunAt: new Date(nextRunAt).toISOString()
  });
  console.log(
    JSON.stringify({
      cycleId,
      action: serialize(action),
      eligibleCount: entries.length,
      recipients: plan.recipients.map((recipient) => ({
        address: recipient.address,
        amount: recipient.amount,
        status: recipient.status,
        txHash: recipient.txHash
      })),
      result
    })
  );

  if (result.status !== "confirmed") process.exitCode = 1;
} finally {
  context.provider.destroy();
}
