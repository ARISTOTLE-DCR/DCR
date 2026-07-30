import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { balances, discover, observe } from "../aristotle-output/input_aristotle/dist/chain.js";
import {
  clearKnownAllowances,
  executePermanentLp
} from "../aristotle-output/input_aristotle/dist/executor.js";
import {
  lpRange,
  nextDelayMs
} from "../aristotle-output/input_aristotle/dist/math.js";
import {
  Store,
  tokenDataDir
} from "../aristotle-output/input_aristotle/dist/store.js";

const token = process.env.TOKEN_ADDRESS;
const rpc = process.env.RPC_URL;
const privateKey = process.env.CREATOR_PRIVATE_KEY;
if (!token || !rpc || !privateKey) {
  throw new Error("TOKEN_ADDRESS, RPC_URL and CREATOR_PRIVATE_KEY are required");
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

const initialState = await store.state(token);
const wait = Math.max(0, initialState.nextRunAt - Date.now());
if (wait > 0) {
  console.log(`waiting ${(wait / 60_000).toFixed(2)} minutes for replaced cycle`);
  await sleep(wait);
}

const context = await discover(rpc, token, privateKey);
try {
  if (!context.signer) throw new Error("signer unavailable");
  if (
    context.signer.address.toLowerCase() !== context.recipient.toLowerCase()
  ) {
    throw new Error("signer is not the resolved PONS fee recipient");
  }

  const state = await store.state(context.token);
  const existing = await store.journal();
  if (existing?.stage === "executing") {
    throw new Error(`cycle ${existing.cycleId} is still executing`);
  }
  await clearKnownAllowances(context);

  const [observation, reservoir] = await Promise.all([
    observe(context, state.lastBlock + 1),
    balances(context)
  ]);
  const pressure =
    (observation.volumeWeth * 1_000_000n) /
    (observation.liquidity + 1n);
  const [tickLower, tickUpper] = lpRange(
    observation.tick,
    observation.tickSpacing,
    pressure
  );
  const action = {
    kind: "permanent_lp",
    amountToken: (reservoir.token * 1_000n) / 10_000n,
    amountWeth: (reservoir.weth * 1_000n) / 10_000n,
    tickLower,
    tickUpper,
    score: pressure,
    reason:
      "operator-scheduled one-cycle override: allocate the DCR v2 maximum to permanent LP"
  };
  if (action.amountToken <= 0n || action.amountWeth <= 0n) {
    throw new Error("LP allocation rounds to zero");
  }

  const cycleId = `0x${randomBytes(32).toString("hex")}`;
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
    activeCycleId: cycleId
  });

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
    decision: serialize(action)
  });

  let lpPlan = {
    cycleId,
    stage: "planned",
    action: serialize(action)
  };
  await store.saveLpPlan(lpPlan);
  journal.stage = "executing";
  journal.updatedAt = Date.now();
  await store.saveJournal(journal);

  const result = await executePermanentLp(
    context,
    action,
    async (stage, data) => {
      if (stage === "mint_prepared") {
        lpPlan = {
          ...lpPlan,
          stage,
          mintTxHash: data.txHash,
          mintRawTx: data.rawTx,
          mintNonce: data.nonce
        };
        journal.pending = {
          phase: "lp_mint",
          hash: data.txHash,
          nonce: data.nonce ?? 0,
          rawTx: data.rawTx
        };
      } else if (stage === "minted") {
        lpPlan = {
          ...lpPlan,
          stage,
          tokenId: data.tokenId,
          mintTxHash: data.txHash
        };
      } else if (stage === "lock_prepared") {
        lpPlan = {
          ...lpPlan,
          stage,
          tokenId: data.tokenId,
          lockTxHash: data.txHash,
          lockRawTx: data.rawTx,
          lockNonce: data.nonce
        };
        journal.pending = {
          phase: "lp_lock",
          hash: data.txHash,
          nonce: data.nonce ?? 0,
          rawTx: data.rawTx
        };
      } else {
        lpPlan = {
          ...lpPlan,
          stage,
          tokenId: data.tokenId,
          lockTxHash: data.txHash
        };
      }
      if (!journal.txHashes.includes(data.txHash)) {
        journal.txHashes.push(data.txHash);
      }
      journal.updatedAt = Date.now();
      await Promise.all([
        store.saveLpPlan(lpPlan),
        store.saveJournal(journal)
      ]);
    }
  );

  const recoverable =
    lpPlan.stage === "mint_prepared" ||
    lpPlan.stage === "minted" ||
    lpPlan.stage === "lock_prepared";
  if (result.status === "confirmed") {
    journal.stage = "confirmed";
    journal.pending = undefined;
  } else {
    journal.stage = recoverable ? "executing" : "failed";
    if (!recoverable) {
      lpPlan = {
        ...lpPlan,
        stage: "failed",
        error: result.detail
      };
      await store.saveLpPlan(lpPlan);
    }
  }
  journal.resultDetail = result.detail;
  journal.txHashes = Array.from(
    new Set([
      ...journal.txHashes,
      ...(result.txHashes ?? []),
      ...(result.txHash ? [result.txHash] : [])
    ])
  );
  journal.updatedAt = Date.now();
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

  await publish("execution", {
    ...result,
    source: "operator-scheduled-transparent-override",
    action: serialize(action),
    cycleId
  });
  await publish("schedule", {
    line: `next cycle in ${(delay / 60_000).toFixed(2)} minutes`,
    delayMs: delay,
    nextRunAt: new Date(nextRunAt).toISOString()
  });
  console.log(JSON.stringify({ cycleId, action: serialize(action), result }));

  if (result.status !== "confirmed" && !recoverable) {
    process.exitCode = 1;
  }
} finally {
  context.provider.destroy();
}
