import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, unlink } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { Store } from "./db.js";

const inheritedEnvironment = { ...process.env };
const observerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(observerRoot, ".env"), override: false });
const agentRoot = resolve(
  observerRoot,
  process.env.AGENT_ROOT ?? "../aristotle-output/input_aristotle"
);
const dataDir = resolve(
  observerRoot,
  process.env.OBSERVER_DATA_DIR ?? "./data"
);
loadEnv({ path: join(agentRoot, ".env"), override: true });
Object.assign(process.env, inheritedEnvironment);

type GasEstimatingProvider = {
  estimateGas(transaction: unknown): Promise<bigint>;
};

const agentEthers = await import(
  pathToFileURL(join(agentRoot, "node_modules/ethers/lib.esm/index.js")).href
) as unknown as {
  JsonRpcProvider: { prototype: GasEstimatingProvider };
};
const providerPrototype = agentEthers.JsonRpcProvider.prototype;
const estimateGasWithoutBuffer = providerPrototype.estimateGas;
providerPrototype.estimateGas = async function (
  this: GasEstimatingProvider,
  transaction: unknown
): Promise<bigint> {
  const estimate = await estimateGasWithoutBuffer.call(this, transaction);
  return (estimate * 120n + 99n) / 100n;
};

const store = new Store(dataDir);
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
let latestCycle: {
  token: string;
  observation?: { block?: number };
  decision: {
    kind: "buy" | "sell";
    amount: string;
    score?: string;
    reason?: string;
  };
} | null = null;
let retryInFlight = false;

function captureRetryableCycle(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const cycle = value as Record<string, unknown>;
  const decision = cycle.decision;
  if (
    typeof cycle.token !== "string" ||
    !decision ||
    typeof decision !== "object"
  ) return;
  const action = decision as Record<string, unknown>;
  if (
    (action.kind !== "buy" && action.kind !== "sell") ||
    typeof action.amount !== "string"
  ) return;
  latestCycle = {
    token: cycle.token,
    ...(cycle.observation && typeof cycle.observation === "object"
      ? { observation: cycle.observation as { block?: number } }
      : {}),
    decision: {
      kind: action.kind,
      amount: action.amount,
      ...(typeof action.score === "string" ? { score: action.score } : {}),
      ...(typeof action.reason === "string" ? { reason: action.reason } : {})
    }
  };
}

function isRetryableRouterFailure(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("too little received") ||
    (
      normalized.includes("transaction execution reverted") &&
      normalized.includes("0xcaf681a66d020601342297493863e78c")
    )
  );
}

async function retryRouterSwap(): Promise<void> {
  if (
    retryInFlight ||
    !latestCycle ||
    process.env.SIGNING_ENABLED !== "true"
  ) return;
  retryInFlight = true;
  const cycle = latestCycle;
  try {
    // The original executor remains untouched. A single immediate retry gives
    // a volatile or under-estimated router transaction fresh execution data.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    const chain = await import(
      pathToFileURL(join(agentRoot, "dist/chain.js")).href
    );
    const executor = await import(
      pathToFileURL(join(agentRoot, "dist/executor.js")).href
    );
    const context = await chain.discover(
      process.env.RPC_URL,
      cycle.token,
      process.env.CREATOR_PRIVATE_KEY || undefined
    );
    try {
      const result = await executor.execute(
        context,
        {
          kind: cycle.decision.kind,
          amount: BigInt(cycle.decision.amount),
          score: BigInt(cycle.decision.score ?? "0"),
          reason:
            `${cycle.decision.reason ?? "DCR signal"}; ` +
            "automatic fresh-quote retry"
        },
        true
      );
      const payload = {
        ...result,
        automaticRetry: true,
        amount: cycle.decision.amount,
        originBlock: cycle.observation?.block
      };
      originalLog("execution retry", payload);
      store.saveAgentEvent("execution", payload);
    } finally {
      context.provider.destroy();
    }
  } catch (error) {
    const payload = {
      status: "failed",
      detail: `automatic fresh-quote retry failed safely: ${String(error).slice(0, 240)}`,
      automaticRetry: true,
      amount: cycle.decision.amount,
      originBlock: cycle.observation?.block
    };
    originalError("execution retry", payload);
    store.saveAgentEvent("execution", payload);
  } finally {
    retryInFlight = false;
  }
}

console.log = (...args: unknown[]): void => {
  originalLog(...args);
  if (args.length === 1 && typeof args[0] === "string") {
    const schedule = args[0].match(/^next cycle in ([0-9.]+) minutes$/);
    if (schedule) {
      const delayMs = Math.round(Number(schedule[1]) * 60_000);
      store.saveAgentEvent("schedule", {
        line: args[0],
        delayMs,
        nextRunAt: new Date(Date.now() + delayMs).toISOString()
      });
      return;
    }
    try {
      const parsed = JSON.parse(args[0]) as unknown;
      captureRetryableCycle(parsed);
      store.saveAgentEvent("cycle", parsed);
    } catch {
      store.saveAgentEvent("stdout", { line: args[0] });
    }
    return;
  }
  const label = args[0];
  if (label === "collection" || label === "execution") {
    store.saveAgentEvent(String(label), args[1]);
    if (
      label === "execution" &&
      args[1] &&
      typeof args[1] === "object" &&
      isRetryableRouterFailure(
        String((args[1] as Record<string, unknown>).detail ?? "")
      )
    ) {
      void retryRouterSwap();
    }
  } else {
    store.saveAgentEvent("stdout", { args });
  }
};

console.error = (...args: unknown[]): void => {
  originalError(...args);
  store.saveAgentEvent("stderr", { args });
};

const deferredStartFile = join(dataDir, "deferred-start.json");
try {
  const deferred = JSON.parse(
    await readFile(deferredStartFile, "utf8")
  ) as { nextRunAt?: string };
  const nextRunAt = Date.parse(deferred.nextRunAt ?? "");
  const delayMs = Math.max(0, nextRunAt - Date.now());
  if (Number.isFinite(nextRunAt) && delayMs > 0) {
    originalLog(`deferred next cycle in ${(delayMs / 60_000).toFixed(2)} minutes`);
    store.saveAgentEvent("schedule", {
      line: "deferred restart after scheduled external cycle",
      delayMs,
      nextRunAt: new Date(nextRunAt).toISOString()
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  await unlink(deferredStartFile);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    originalError("deferred start ignored safely:", error);
  }
}

process.chdir(agentRoot);
await import(pathToFileURL(join(agentRoot, "dist/cli.js")).href);
