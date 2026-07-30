import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const store = new Store(dataDir);
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function saveSchedule(line: string): boolean {
  const schedule = line.match(
    /(?:honoring persisted schedule;\s*)?next cycle in ([0-9.]+) minutes/
  );
  if (!schedule) return false;
  const delayMs = Math.round(Number(schedule[1]) * 60_000);
  store.saveAgentEvent("schedule", {
    line,
    delayMs,
    nextRunAt: new Date(Date.now() + delayMs).toISOString()
  });
  return true;
}

function captureLine(line: string): void {
  if (saveSchedule(line)) return;
  try {
    store.saveAgentEvent("cycle", JSON.parse(line) as unknown);
  } catch {
    store.saveAgentEvent("stdout", { line });
  }
}

function captureLabel(args: unknown[]): void {
  const label = String(args[0] ?? "stdout");
  const knownLabels = new Set([
    "collection",
    "execution",
    "LP recovery",
    "airdrop recovery"
  ]);
  if (knownLabels.has(label)) {
    store.saveAgentEvent(
      label.toLowerCase().replaceAll(" ", "-"),
      args[1] ?? null
    );
  } else {
    store.saveAgentEvent("stdout", { args });
  }
}

console.log = (...args: unknown[]): void => {
  originalLog(...args);
  if (args.length === 1 && typeof args[0] === "string") {
    captureLine(args[0]);
  } else {
    captureLabel(args);
  }
};

console.warn = (...args: unknown[]): void => {
  originalWarn(...args);
  store.saveAgentEvent("warning", { args });
};

console.error = (...args: unknown[]): void => {
  originalError(...args);
  store.saveAgentEvent("stderr", { args });
};

process.chdir(agentRoot);
await import(pathToFileURL(join(agentRoot, "dist/cli.js")).href);
