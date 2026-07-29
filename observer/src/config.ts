import "dotenv/config";
import { resolve } from "node:path";

const root = process.cwd();

export const config = {
  port: Number(process.env.OBSERVER_PORT ?? 4174),
  host: process.env.OBSERVER_HOST ?? "127.0.0.1",
  pollMs: Math.max(5_000, Number(process.env.OBSERVER_POLL_MS ?? 15_000)),
  token: process.env.TOKEN_ADDRESS ?? "0xbe284496abf795cb2ee007e947212343a7cf3c65",
  rpc: process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  agentRoot: resolve(root, process.env.AGENT_ROOT ?? "../aristotle-output/input_aristotle"),
  stateFile: resolve(root, process.env.AGENT_STATE_FILE ?? "../aristotle-output/input_aristotle/data/state.json"),
  archive: resolve(root, process.env.ARISTOTLE_ARCHIVE ?? "../aristotle-result.tar.gz"),
  dataDir: resolve(root, process.env.OBSERVER_DATA_DIR ?? "./data"),
  dashboardDist: resolve(root, process.env.DASHBOARD_DIST ?? "../dashboard/dist")
};
