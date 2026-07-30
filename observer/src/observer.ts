import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  zeroPadValue
} from "ethers";
import { config } from "./config.js";
import { Store } from "./db.js";
import { hashProof } from "./provenance.js";
import type {
  Activity,
  DecisionView,
  Snapshot
} from "./types.js";

const CLAIM_ABI = [
  "error NoFeesToCollect()",
  "function collectFees(address) returns(uint256,uint256)",
  "event FeesClaimed(address indexed token,address indexed caller,address token0,address token1,uint256 recipientAmount0,uint256 recipientAmount1,uint256 protocolAmount0,uint256 protocolAmount1)"
];
const POOL_ABI = [
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"
];
const TOKEN_ABI = [
  "function name() view returns(string)",
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
];
const NO_FEES_SELECTOR = "0x6a4ea9e4";

interface AgentState {
  version: 2;
  token: string;
  lastBlock: number;
  lastTimestamp: number;
  lastSqrtPriceX96: string;
  reserveWeth: string;
  reserveToken: string;
  flowIntegral: string;
  lastActionAt: number;
  nextRunAt: number;
  cycleSeq: number;
  activeCycleId?: string;
  holderCursor: number;
}

interface HolderIndex {
  launchBlock: number;
  cursor: number;
  completeThrough: number;
  balances: Record<string, string>;
}

interface CycleJournal {
  cycleId: string;
  action: Record<string, unknown>;
  stage: "planned" | "executing" | "confirmed" | "failed";
  updatedAt: number;
}

interface LpPlan {
  cycleId: string;
  stage:
    | "planned"
    | "mint_prepared"
    | "minted"
    | "lock_prepared"
    | "locked"
    | "failed";
  tokenId?: string;
}

interface AirdropPlan {
  cycleId: string;
  totalWeth: string;
  recipientCount?: number;
  recipients: Array<{
    status: "pending" | "submitted" | "confirmed" | "failed";
  }>;
}

interface AgentModules {
  constants: Record<string, unknown>;
  chain: Record<string, (...args: never[]) => Promise<unknown>>;
  math: Record<string, (...args: never[]) => unknown>;
}

interface Sidecars {
  holderIndex?: HolderIndex | undefined;
  cycle?: CycleJournal | undefined;
  lp?: LpPlan | undefined;
  airdrop?: AirdropPlan | undefined;
}

let modulesPromise: Promise<AgentModules> | undefined;

async function agentModules(): Promise<AgentModules> {
  modulesPromise ??= Promise.all([
    import(pathToFileURL(join(config.agentRoot, "dist/constants.js")).href),
    import(pathToFileURL(join(config.agentRoot, "dist/chain.js")).href),
    import(pathToFileURL(join(config.agentRoot, "dist/math.js")).href)
  ]).then(([constants, chain, math]) => ({
    constants: constants as Record<string, unknown>,
    chain: chain as AgentModules["chain"],
    math: math as AgentModules["math"]
  }));
  return modulesPromise;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readState(
  initialState: (token: string) => AgentState
): Promise<AgentState> {
  const state = await readJson<AgentState>(config.stateFile);
  return state?.version === 2 ? state : initialState(config.token);
}

async function readSidecars(): Promise<Sidecars> {
  const [holderIndex, cycle, lp, airdrop] = await Promise.all([
    readJson<HolderIndex>(join(config.agentDataDir, "holders.json")),
    readJson<CycleJournal>(join(config.agentDataDir, "cycle.json")),
    readJson<LpPlan>(join(config.agentDataDir, "lp.json")),
    readJson<AirdropPlan>(join(config.agentDataDir, "airdrop.json"))
  ]);
  return { holderIndex, cycle, lp, airdrop };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function containsNoFees(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false;
    seen.add(value);
    if (typeof value === "string") {
      return value.includes("NoFeesToCollect") ||
        value.includes(NO_FEES_SELECTOR);
    }
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return visit(error);
}

function decisionView(
  action: Record<string, unknown>,
  quoteOut?: bigint
): DecisionView {
  const result: DecisionView = {
    kind: action.kind as DecisionView["kind"],
    reason: String(action.reason ?? "")
  };
  for (const field of [
    "amount",
    "amountToken",
    "amountWeth",
    "total",
    "score"
  ] as const) {
    const value = action[field];
    if (typeof value === "bigint" || typeof value === "string") {
      result[field] = value.toString();
    }
  }
  for (const field of [
    "recipientCount",
    "snapshotBlock",
    "tickLower",
    "tickUpper"
  ] as const) {
    const value = action[field];
    if (typeof value === "number") result[field] = value;
  }
  if (quoteOut !== undefined) result.quoteOut = quoteOut.toString();
  return result;
}

async function claimPreview(
  provider: JsonRpcProvider,
  lockerAddress: string,
  token: string,
  recipient: string,
  tokenIs0: boolean
): Promise<Snapshot["claim"]> {
  const locker: any = new Contract(lockerAddress, CLAIM_ABI, provider);
  try {
    const result = await locker.collectFees.staticCall(token, {
      from: recipient
    });
    const amount0 = result[0] as bigint;
    const amount1 = result[1] as bigint;
    return {
      status: "claimable",
      weth: (tokenIs0 ? amount1 : amount0).toString(),
      token: (tokenIs0 ? amount0 : amount1).toString()
    };
  } catch (error) {
    if (containsNoFees(error)) return { status: "empty" };
    return {
      status: "unavailable",
      detail: errorText(error).slice(0, 200)
    };
  }
}

function agentOnline(state: AgentState): boolean {
  if (!state.lastTimestamp) return false;
  const recentlyObserved =
    Math.abs(Date.now() / 1_000 - state.lastTimestamp) < 30 * 60;
  const schedulePlausible =
    state.nextRunAt === 0 || state.nextRunAt > Date.now() - 5 * 60_000;
  return recentlyObserved && schedulePlausible;
}

function trackedHolderCount(index?: HolderIndex): number {
  if (!index) return 0;
  return Object.values(index.balances).filter((value) => BigInt(value) > 0n)
    .length;
}

function airdropStage(
  plan?: AirdropPlan
): Snapshot["operations"]["airdrop"]["stage"] {
  if (!plan) return "none";
  if (plan.recipients.some((recipient) => recipient.status === "failed")) {
    return "failed";
  }
  if (plan.recipients.length === 0) return "committed";
  if (
    plan.recipients.every((recipient) => recipient.status === "confirmed")
  ) {
    return "confirmed";
  }
  return "paying";
}

export class Observer {
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private listeners = new Set<(snapshot: Snapshot) => void>();

  constructor(private readonly store: Store) {}

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async poll(): Promise<Snapshot> {
    if (this.busy) {
      const latest = this.store.latestSnapshot();
      if (latest) return latest;
      throw new Error("observer poll already in progress");
    }
    this.busy = true;
    try {
      const { constants, chain, math } = await agentModules();
      const discover = chain.discover as unknown as (
        rpc: string,
        token: string
      ) => Promise<Record<string, unknown>>;
      const observe = chain.observe as unknown as (
        context: Record<string, unknown>,
        fromBlock: number
      ) => Promise<Record<string, unknown>>;
      const balances = chain.balances as unknown as (
        context: Record<string, unknown>
      ) => Promise<{ weth: bigint; token: bigint }>;
      const quote = chain.quote as unknown as (
        context: Record<string, unknown>,
        action: Record<string, unknown>
      ) => Promise<bigint>;
      const decide = math.decide as unknown as (
        observation: Record<string, unknown>,
        state: AgentState,
        weth: bigint,
        token: bigint,
        tokenIs0: boolean,
        availability: {
          holderCount: number;
          holderIndexComplete: boolean;
        }
      ) => Record<string, unknown>;
      const initialState = math.initialState as unknown as (
        token: string
      ) => AgentState;
      const valueTokenInWeth = math.valueTokenInWeth as unknown as (
        amount: bigint,
        sqrt: bigint,
        tokenIs0: boolean
      ) => bigint;

      const context = await discover(config.rpc, config.token);
      const provider = context.provider as JsonRpcProvider;
      const [state, sidecars] = await Promise.all([
        readState(initialState),
        readSidecars()
      ]);
      const [observation, treasury, block, nativeBalance] = await Promise.all([
        observe(context, state.lastBlock + 1),
        balances(context),
        provider.getBlock("latest"),
        provider.getBalance(context.recipient as string)
      ]);
      if (!block) throw new Error("latest block unavailable");

      const tokenContract: any = new Contract(config.token, TOKEN_ABI, provider);
      const [name, symbol, decimalsRaw, totalSupply] = await Promise.all([
        tokenContract.name() as Promise<string>,
        tokenContract.symbol() as Promise<string>,
        tokenContract.decimals() as Promise<bigint>,
        tokenContract.totalSupply() as Promise<bigint>
      ]);
      const decimals = Number(decimalsRaw);
      const holderTarget = Math.max(
        (sidecars.holderIndex?.launchBlock ?? 1) - 1,
        (observation.block as number) - 12
      );
      const holderCount = trackedHolderCount(sidecars.holderIndex);
      const holderComplete =
        (sidecars.holderIndex?.completeThrough ?? 0) >= holderTarget;
      const computedAction = decide(
        observation,
        state,
        treasury.weth,
        treasury.token,
        context.tokenIs0 as boolean,
        {
          holderCount,
          holderIndexComplete: holderComplete && holderCount > 0
        }
      );
      const action =
        sidecars.cycle?.action &&
        sidecars.cycle.cycleId === state.activeCycleId
          ? sidecars.cycle.action
          : computedAction;
      let quoteOut: bigint | undefined;
      if (action.kind === "buy" || action.kind === "sell") {
        try {
          const quoteAction = {
            ...action,
            amount: BigInt(String(action.amount))
          };
          quoteOut = await quote(context, quoteAction);
        } catch {
          quoteOut = undefined;
        }
      }

      const sqrtPriceX96 = observation.sqrtPriceX96 as bigint;
      const oneToken = 10n ** BigInt(decimals);
      const priceWei = valueTokenInWeth(
        oneToken,
        sqrtPriceX96,
        context.tokenIs0 as boolean
      );
      const marketCapWei = valueTokenInWeth(
        totalSupply,
        sqrtPriceX96,
        context.tokenIs0 as boolean
      );
      const claim = await claimPreview(
        provider,
        constants.LOCKER as string,
        config.token,
        context.recipient as string,
        context.tokenIs0 as boolean
      );
      const confirmedRecipients =
        sidecars.airdrop?.recipients.filter(
          (recipient) => recipient.status === "confirmed"
        ).length ?? 0;

      const unsigned = {
        capturedAt: new Date().toISOString(),
        block: block.number,
        blockTimestamp: block.timestamp,
        chainId: 4663,
        token: {
          address: getAddress(config.token),
          name,
          symbol,
          decimals,
          totalSupply: totalSupply.toString()
        },
        pool: {
          address: context.pool as string,
          sqrtPriceX96: sqrtPriceX96.toString(),
          liquidity: (observation.liquidity as bigint).toString(),
          priceWeth: formatUnits(priceWei, 18),
          marketCapWeth: formatUnits(marketCapWei, 18),
          volumeWeth: formatUnits(observation.volumeWeth as bigint, 18),
          swapCount: observation.swapCount as number
        },
        treasury: {
          address: context.recipient as string,
          wethBalance: formatUnits(treasury.weth, 18),
          tokenBalance: formatUnits(treasury.token, decimals),
          nativeEthBalance: formatEther(nativeBalance)
        },
        claim,
        decision: decisionView(action, quoteOut),
        liveDecision: decisionView(computedAction),
        agent: {
          online: agentOnline(state),
          stateBlock: state.lastBlock,
          stateTimestamp: state.lastTimestamp,
          lastActionAt: state.lastActionAt,
          nextRunAt: state.nextRunAt,
          cycleSeq: state.cycleSeq,
          activeCycleId: state.activeCycleId
        },
        operations: {
          holderIndex: {
            cursor: sidecars.holderIndex?.cursor ?? 0,
            target: holderTarget,
            trackedAddresses: holderCount,
            complete: holderComplete
          },
          cycle: {
            id: sidecars.cycle?.cycleId,
            stage: sidecars.cycle?.stage ?? "none",
            updatedAt: sidecars.cycle?.updatedAt
          },
          lp: {
            cycleId: sidecars.lp?.cycleId,
            stage: sidecars.lp?.stage ?? "none",
            tokenId: sidecars.lp?.tokenId
          },
          airdrop: {
            cycleId: sidecars.airdrop?.cycleId,
            stage: airdropStage(sidecars.airdrop),
            totalWeth: sidecars.airdrop?.totalWeth,
            recipientCount:
              sidecars.airdrop?.recipientCount ??
              sidecars.airdrop?.recipients.length ??
              0,
            confirmedCount: confirmedRecipients
          }
        }
      } satisfies Omit<Snapshot, "proofHash" | "id">;
      const snapshot: Snapshot = {
        ...unsigned,
        proofHash: hashProof(unsigned)
      };

      this.store.saveSnapshot(snapshot);
      await this.indexActivity(provider, context, block.number, constants);
      for (const listener of this.listeners) listener(snapshot);
      return snapshot;
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    const loop = async (): Promise<void> => {
      try {
        await this.poll();
      } catch (error) {
        this.store.saveAgentEvent("observer-error", {
          message: errorText(error)
        });
      }
    };
    void loop();
    this.timer = setInterval(() => void loop(), config.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async indexActivity(
    provider: JsonRpcProvider,
    context: Record<string, unknown>,
    latest: number,
    constants: Record<string, unknown>
  ): Promise<void> {
    const previous = Number(this.store.getMeta("activity_cursor") ?? 0);
    const fromBlock = Math.max(previous + 1, latest - 500);
    if (fromBlock > latest) return;

    const feeInterface = new Interface(CLAIM_ABI);
    const poolInterface = new Interface(POOL_ABI);
    const tokenInterface = new Interface(TOKEN_ABI);
    const feeTopic = feeInterface.getEvent("FeesClaimed")!.topicHash;
    const swapTopic = poolInterface.getEvent("Swap")!.topicHash;
    const transferTopic = tokenInterface.getEvent("Transfer")!.topicHash;
    const tokenTopic = zeroPadValue(getAddress(config.token), 32);
    const recipientTopic = zeroPadValue(
      getAddress(context.recipient as string),
      32
    );
    const burnTopic = zeroPadValue(getAddress(constants.BURN as string), 32);
    const [feeLogs, swapLogs, burnLogs] = await Promise.all([
      provider.getLogs({
        address: constants.LOCKER as string,
        fromBlock,
        toBlock: latest,
        topics: [feeTopic, tokenTopic]
      }),
      provider.getLogs({
        address: context.pool as string,
        fromBlock,
        toBlock: latest,
        topics: [swapTopic]
      }),
      provider.getLogs({
        address: config.token,
        fromBlock,
        toBlock: latest,
        topics: [transferTopic, recipientTopic, burnTopic]
      })
    ]);

    for (const log of feeLogs) {
      const event = feeInterface.parseLog(log);
      if (!event) continue;
      const tokenIs0 = context.tokenIs0 as boolean;
      const amount0 = event.args.recipientAmount0 as bigint;
      const amount1 = event.args.recipientAmount1 as bigint;
      this.store.saveActivity({
        kind: "claim",
        status: "confirmed",
        timestamp: new Date().toISOString(),
        block: log.blockNumber,
        txHash: log.transactionHash,
        amountIn: (tokenIs0 ? amount1 : amount0).toString(),
        amountOut: (tokenIs0 ? amount0 : amount1).toString(),
        assetIn: "WETH",
        assetOut: "TOKEN",
        payload: {
          caller: event.args.caller,
          protocolAmount0: (event.args.protocolAmount0 as bigint).toString(),
          protocolAmount1: (event.args.protocolAmount1 as bigint).toString()
        }
      });
    }

    for (const log of swapLogs) {
      const event = poolInterface.parseLog(log);
      if (!event) continue;
      if (
        getAddress(event.args.recipient as string) !==
        getAddress(context.recipient as string)
      ) {
        continue;
      }
      const amount0 = event.args.amount0 as bigint;
      const amount1 = event.args.amount1 as bigint;
      const tokenAmount = context.tokenIs0 ? amount0 : amount1;
      const wethAmount = context.tokenIs0 ? amount1 : amount0;
      const isBuy = wethAmount > 0n;
      const activity: Activity = isBuy
        ? {
            kind: "buy",
            status: "confirmed",
            timestamp: new Date().toISOString(),
            block: log.blockNumber,
            txHash: log.transactionHash,
            amountIn: wethAmount.toString(),
            amountOut: (-tokenAmount).toString(),
            assetIn: "WETH",
            assetOut: "TOKEN"
          }
        : {
            kind: "sell",
            status: "confirmed",
            timestamp: new Date().toISOString(),
            block: log.blockNumber,
            txHash: log.transactionHash,
            amountIn: tokenAmount.toString(),
            amountOut: (-wethAmount).toString(),
            assetIn: "TOKEN",
            assetOut: "WETH"
          };
      this.store.saveActivity(activity);
    }

    for (const log of burnLogs) {
      const event = tokenInterface.parseLog(log);
      if (!event) continue;
      this.store.saveActivity({
        kind: "burn",
        status: "confirmed",
        timestamp: new Date().toISOString(),
        block: log.blockNumber,
        txHash: log.transactionHash,
        amountIn: (event.args.value as bigint).toString(),
        assetIn: "TOKEN",
        assetOut: "BURN_ADDRESS"
      });
    }

    this.store.setMeta("activity_cursor", String(latest));
  }
}
