import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const [, , source, target, token, nextRunAtInput] = process.argv;
if (!source || !target || !token)
  throw new Error(
    "usage: node migrate-v1.mjs <v1-state.json> <v2-state.json> <token>",
  );
const v = JSON.parse(await readFile(source, "utf8"));
if (v.version !== 1) throw new Error("source is not DCR v1");
const n = {
  version: 2,
  token,
  lastBlock: v.lastBlock ?? 0,
  lastTimestamp: v.lastTimestamp ?? 0,
  lastSqrtPriceX96: v.lastSqrtPriceX96 ?? "0",
  reserveWeth: v.reserveWeth ?? "0",
  reserveToken: v.reserveToken ?? "0",
  flowIntegral: v.integral ?? "0",
  lastActionAt: v.lastActionAt ?? 0,
  nextRunAt: Number(nextRunAtInput ?? 0),
  cycleSeq: 0,
  holderCursor: 0,
};
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(n, null, 2));
console.log("migrated baseline", n.lastSqrtPriceX96);
