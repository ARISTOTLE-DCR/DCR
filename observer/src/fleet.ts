import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Wallet, getAddress } from "ethers";
import { Store } from "./db.js";

type LaunchRecord = {
  id: string;
  stage: string;
  tokenAddress?: string;
  walletAddress?: string;
  keystoreFile?: string;
  launchBlock?: number;
};

type Registry = { version: 1; records: LaunchRecord[] };
type Worker = { child: ChildProcess; token: string };

const enabled = process.env.FLEET_ENABLED === "true";
const signingEnabled = process.env.FLEET_SIGNING_ENABLED === "true";
const registryFile = process.env.LAUNCH_REGISTRY_FILE ?? "/var/lib/dcr-launcher/registry.json";
const walletPassword = process.env.LAUNCH_WALLET_PASSWORD ?? "";
const rpc = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const agentRoot = resolve(process.env.AGENT_ROOT ?? "../aristotle-output/input_aristotle");
const dataRoot = resolve(process.env.FLEET_OBSERVER_DATA_ROOT ?? "./data");
const workers = new Map<string, Worker>();
let stopping = false;

if (enabled && !walletPassword) throw new Error("LAUNCH_WALLET_PASSWORD is required when FLEET_ENABLED=true");

async function readRegistry(): Promise<Registry> {
  try {
    const data = JSON.parse(await readFile(registryFile, "utf8")) as Registry;
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("Unsupported launch registry.");
    return data;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { version: 1, records: [] };
    }
    throw error;
  }
}

async function startWorker(record: LaunchRecord): Promise<void> {
  if (!record.tokenAddress || !record.walletAddress || !record.keystoreFile || !record.launchBlock) return;
  const token = getAddress(record.tokenAddress);
  const key = token.toLowerCase();
  if (workers.has(key)) return;

  const encrypted = await readFile(record.keystoreFile, "utf8");
  const wallet = await Wallet.fromEncryptedJson(encrypted, walletPassword);
  if (getAddress(wallet.address) !== getAddress(record.walletAddress)) {
    throw new Error(`Encrypted wallet address mismatch for ${token}`);
  }
  const slug = token.toLowerCase().replace(/^0x/, "");
  const store = new Store(join(dataRoot, slug));
  const child = spawn(process.execPath, [join(agentRoot, "dist/cli.js")], {
    cwd: agentRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TOKEN_ADDRESS: token,
      CREATOR_PRIVATE_KEY: wallet.privateKey,
      RPC_URL: rpc,
      SIGNING_ENABLED: signingEnabled ? "true" : "false",
      DATA_ROOT: join(agentRoot, "data"),
      TOKEN_LAUNCH_BLOCK: String(record.launchBlock),
      TRANSACTION_LOCK_DIR: process.env.TRANSACTION_LOCK_DIR ?? "/var/lib/dcr-launcher/locks"
    }
  });
  workers.set(key, { child, token });
  store.saveAgentEvent("fleet-worker-started", { token, pid: child.pid, signingEnabled });

  const stdout = createInterface({ input: child.stdout! });
  stdout.on("line", (line) => captureLine(store, line));
  const stderr = createInterface({ input: child.stderr! });
  stderr.on("line", (line) => store.saveAgentEvent("stderr", { line: redact(line) }));
  child.once("exit", (code, signal) => {
    workers.delete(key);
    store.saveAgentEvent("fleet-worker-exited", { token, code, signal });
  });
}

function captureLine(store: Store, line: string): void {
  const schedule = line.match(/(?:honoring persisted schedule;\s*)?next cycle in ([0-9.]+) minutes/);
  if (schedule) {
    const delayMs = Math.round(Number(schedule[1]) * 60_000);
    store.saveAgentEvent("schedule", { line, delayMs, nextRunAt: new Date(Date.now() + delayMs).toISOString() });
    return;
  }
  try {
    store.saveAgentEvent("cycle", JSON.parse(line) as unknown);
  } catch {
    store.saveAgentEvent("stdout", { line: redact(line) });
  }
}

function redact(value: string): string {
  return value.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]");
}

async function reconcile(): Promise<void> {
  if (!enabled || stopping) return;
  const registry = await readRegistry();
  for (const record of registry.records) {
    if (record.stage !== "launched") continue;
    try {
      await startWorker(record);
    } catch (error) {
      const token = record.tokenAddress ?? record.id;
      const slug = token.toLowerCase().replace(/^0x/, "");
      new Store(join(dataRoot, slug)).saveAgentEvent("fleet-worker-error", {
        token,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const { child } of workers.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`DCR fleet supervisor: ${enabled ? "enabled" : "disabled"}; signing=${signingEnabled}`);
await reconcile();
const timer = setInterval(() => void reconcile(), 5_000);
