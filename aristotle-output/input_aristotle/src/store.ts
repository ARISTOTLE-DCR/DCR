import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { State } from "./math.js";
import { initialState } from "./math.js";
import type { AirdropPlan, HolderIndex } from "./airdrop.js";
export interface LpPlan {
  cycleId: string;
  stage:
    | "planned"
    | "mint_prepared"
    | "minted"
    | "lock_prepared"
    | "locked"
    | "failed";
  action: {
    kind: "permanent_lp";
    amountToken: string;
    amountWeth: string;
    tickLower: number;
    tickUpper: number;
    score: string;
    reason: string;
  };
  tokenId?: string | undefined;
  mintTxHash?: string | undefined;
  mintRawTx?: string | undefined;
  mintNonce?: number | undefined;
  lockTxHash?: string | undefined;
  lockRawTx?: string | undefined;
  lockNonce?: number | undefined;
  error?: string | undefined;
}
export interface PendingTransaction {
  phase: "swap" | "burn" | "lp_mint" | "lp_lock" | "airdrop";
  hash: string;
  nonce: number;
  rawTx?: string | undefined;
}
export interface CycleJournal {
  cycleId: string;
  block: number;
  action: unknown;
  stage: "planned" | "executing" | "confirmed" | "failed";
  txHashes: string[];
  pending?: PendingTransaction | undefined;
  resultDetail?: string | undefined;
  createdAt: number;
  updatedAt: number;
}
async function read<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + `.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      value,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  await rename(tmp, file);
}
export class Store {
  constructor(readonly root: string) {}
  path(n: string) {
    return join(this.root, n);
  }
  async state(token: string): Promise<State> {
    const raw = await read<any>(this.path("state.json"));
    if (raw?.version === 2) return raw as State;
    if (raw?.version === 1)
      return {
        ...initialState(token),
        lastBlock: raw.lastBlock ?? 0,
        lastTimestamp: raw.lastTimestamp ?? 0,
        lastSqrtPriceX96: raw.lastSqrtPriceX96 ?? "0",
        reserveWeth: raw.reserveWeth ?? "0",
        reserveToken: raw.reserveToken ?? "0",
        flowIntegral: raw.integral ?? "0",
        lastActionAt: raw.lastActionAt ?? 0,
      };
    return initialState(token);
  }
  saveState(s: State) {
    return atomic(this.path("state.json"), s);
  }
  journal() {
    return read<CycleJournal>(this.path("cycle.json"));
  }
  saveJournal(j: CycleJournal) {
    return atomic(this.path("cycle.json"), j);
  }
  async index(launchBlock: number): Promise<HolderIndex> {
    return (
      (await read<HolderIndex>(this.path("holders.json"))) ?? {
        version: 1,
        launchBlock,
        cursor: launchBlock - 1,
        cursorHash: "",
        balances: {},
        completeThrough: launchBlock - 1,
      }
    );
  }
  saveIndex(i: HolderIndex) {
    return atomic(this.path("holders.json"), i);
  }
  plan() {
    return read<AirdropPlan>(this.path("airdrop.json"));
  }
  savePlan(p: AirdropPlan) {
    return atomic(this.path("airdrop.json"), p);
  }
  lpPlan() {
    return read<LpPlan>(this.path("lp.json"));
  }
  saveLpPlan(p: LpPlan) {
    return atomic(this.path("lp.json"), p);
  }
}
export function tokenDataDir(base: string, token: string): string {
  return join(base, token.toLowerCase().replace(/^0x/, ""));
}
