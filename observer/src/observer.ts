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
import type { Activity, DecisionView, Snapshot } from "./types.js";

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
  "function totalSupply() view returns(uint256)"
];
const NO_FEES_SELECTOR = "0x6a4ea9e4";

interface AgentState {
  version: 1;
  lastBlock: number;
  lastTimestamp: number;
  lastSqrtPriceX96: string;
  reserveWeth: string;
  reserveToken: string;
  integral: string;
  lastActionAt: number;
}

interface AgentModules {
  constants: Record<string, unknown>;
  chain: Record<string, (...args: never[]) => Promise<unknown>>;
  math: Record<string, (...args: never[]) => unknown>;
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

async function readState(initialState: () => AgentState): Promise<AgentState> {
  try {
    return JSON.parse(await readFile(config.stateFile, "utf8")) as AgentState;
  } catch {
    return initialState();
  }
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
      return value.includes("NoFeesToCollect") || value.includes(NO_FEES_SELECTOR);
    }
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return visit(error) || containsText(errorText(error));
}

function containsText(value: string): boolean {
  return value.includes("NoFeesToCollect") || value.includes(NO_FEES_SELECTOR);
}

function decisionView(action: Record<string, unknown>, quoteOut?: bigint): DecisionView {
  const result: DecisionView = {
    kind: action.kind as DecisionView["kind"],
    reason: String(action.reason ?? "")
  };
  if (typeof action.amount === "bigint") result.amount = action.amount.toString();
  if (typeof action.score === "bigint") result.score = action.score.toString();
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
    const result = await locker.collectFees.staticCall(token, { from: recipient });
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
  return Math.abs(Date.now() / 1_000 - state.lastTimestamp) < 30 * 60;
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
        tokenIs0: boolean
      ) => Record<string, unknown>;
      const initialState = math.initialState as unknown as () => AgentState;
      const valueTokenInWeth = math.valueTokenInWeth as unknown as (
        amount: bigint,
        sqrt: bigint,
        tokenIs0: boolean
      ) => bigint;

      const context = await discover(config.rpc, config.token);
      const provider = context.provider as JsonRpcProvider;
      const state = await readState(initialState);
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
      const action = decide(
        observation,
        state,
        treasury.weth,
        treasury.token,
        context.tokenIs0 as boolean
      );
      let quoteOut: bigint | undefined;
      if (action.kind === "buy" || action.kind === "sell") {
        try {
          quoteOut = await quote(context, action);
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
        agent: {
          online: agentOnline(state),
          stateBlock: state.lastBlock,
          stateTimestamp: state.lastTimestamp,
          lastActionAt: state.lastActionAt
        }
      };
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
    const feeTopic = feeInterface.getEvent("FeesClaimed")!.topicHash;
    const swapTopic = poolInterface.getEvent("Swap")!.topicHash;
    const tokenTopic = zeroPadValue(getAddress(config.token), 32);
    const [feeLogs, swapLogs] = await Promise.all([
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
      if (getAddress(event.args.recipient as string) !== getAddress(context.recipient as string)) {
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

    this.store.setMeta("activity_cursor", String(latest));
  }
}
