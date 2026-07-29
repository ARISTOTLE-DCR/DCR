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
const originalError = console.error.bind(console);

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
      store.saveAgentEvent("cycle", parsed);
    } catch {
      store.saveAgentEvent("stdout", { line: args[0] });
    }
    return;
  }
  const label = args[0];
  if (label === "collection" || label === "execution") {
    store.saveAgentEvent(String(label), args[1]);
  } else {
    store.saveAgentEvent("stdout", { args });
  }
};

console.error = (...args: unknown[]): void => {
  originalError(...args);
  store.saveAgentEvent("stderr", { args });
};

process.chdir(agentRoot);
await import(pathToFileURL(join(agentRoot, "dist/cli.js")).href);
