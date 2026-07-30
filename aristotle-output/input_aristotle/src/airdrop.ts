import {
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
  solidityPackedKeccak256,
} from "ethers";
import {
  ABIS,
  BURN,
  FACTORY,
  LOCKER,
  POSITION_MANAGER,
  QUOTER,
  ROUTER,
  WETH,
} from "./constants.js";
import type { Context } from "./chain.js";
export interface HolderIndex {
  version: 1;
  launchBlock: number;
  cursor: number;
  cursorHash: string;
  balances: Record<string, string>;
  completeThrough: number;
}
export interface Payout {
  address: string;
  amount: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash?: string | undefined;
  rawTx?: string | undefined;
  nonce?: number | undefined;
  receiptBlock?: number | undefined;
  senderBefore?: string | undefined;
  recipientBefore?: string | undefined;
}
export interface AirdropPlan {
  version: 1;
  cycleId: string;
  snapshotBlock: number;
  anchorBlock: number;
  eligibleSetHash: string;
  seed?: string | undefined;
  totalWeth: string;
  recipientCount?: number | undefined;
  recipients: Payout[];
}
const iface = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export async function syncHolderIndex(
  provider: JsonRpcProvider,
  token: string,
  index: HolderIndex,
  target: number,
  chunk = 1500,
): Promise<HolderIndex> {
  let out = structuredClone(index);
  if (out.cursor >= out.launchBlock && out.cursorHash) {
    const canonical = await provider.getBlock(out.cursor);
    if (!canonical?.hash || canonical.hash !== out.cursorHash)
      out = {
        version: 1,
        launchBlock: out.launchBlock,
        cursor: out.launchBlock - 1,
        cursorHash: "",
        balances: {},
        completeThrough: out.launchBlock - 1,
      };
  }
  while (out.cursor < target) {
    const from = out.cursor + 1,
      to = Math.min(target, from + chunk - 1);
    const logs = await provider.getLogs({
      address: token,
      fromBlock: from,
      toBlock: to,
      topics: [iface.getEvent("Transfer")!.topicHash],
    });
    const seen = new Set<string>();
    for (const log of logs) {
      const id = `${log.transactionHash}:${log.index}`;
      if (seen.has(id)) throw new Error("duplicate transfer log");
      seen.add(id);
      const e = iface.parseLog(log)!;
      const a = getAddress(e.args.from),
        b = getAddress(e.args.to),
        v = e.args.value as bigint;
      if (a !== ZeroAddress) {
        const n = BigInt(out.balances[a] ?? "0") - v;
        if (n < 0n) throw new Error("negative reconstructed holder balance");
        out.balances[a] = n.toString();
      }
      if (b !== ZeroAddress)
        out.balances[b] = (BigInt(out.balances[b] ?? "0") + v).toString();
    }
    const block = await provider.getBlock(to);
    if (!block?.hash) throw new Error("cursor block unavailable");
    out.cursor = to;
    out.cursorHash = block.hash;
    out.completeThrough = to;
  }
  return out;
}
export async function eligibleHolders(
  ctx: Context,
  index: HolderIndex,
  snapshot: number,
): Promise<Array<[string, bigint]>> {
  if (index.completeThrough < snapshot)
    throw new Error("holder index incomplete for snapshot");
  const excluded = new Set(
    [
      ZeroAddress,
      BURN,
      ctx.recipient,
      ctx.token,
      ctx.pool,
      FACTORY,
      LOCKER,
      ROUTER,
      QUOTER,
      POSITION_MANAGER,
    ].map((x) => getAddress(x)),
  );
  const token: any = new Contract(ctx.token, ABIS.token, ctx.provider);
  const candidates = Object.entries(index.balances)
    .filter(([a, b]) => !excluded.has(getAddress(a)) && BigInt(b) > 0n)
    .sort(([a], [b]) => a.localeCompare(b));
  const result: Array<[string, bigint]> = [];
  for (const [a] of candidates) {
    const balance: bigint = await token.balanceOf(a, { blockTag: snapshot });
    if (balance > 0n) result.push([getAddress(a), balance]);
  }
  return result;
}
export function eligibleCommitment(entries: Array<[string, bigint]>): string {
  return solidityPackedKeccak256(
    ["bytes"],
    [
      "0x" +
        entries
          .map(
            ([a, b]) =>
              a.slice(2).toLowerCase() + b.toString(16).padStart(64, "0"),
          )
          .join(""),
    ],
  );
}
function draw(seed: string, i: number, n: number): number {
  const space = 1n << 256n,
    limit = space - (space % BigInt(n));
  let j = 0;
  for (;;) {
    const h = solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256"],
      [seed, i, j++],
    );
    const x = BigInt(h);
    if (x < limit) return Number(x % BigInt(n));
  }
}
/** Uniform-holder sampling is transparent and gives each reconciled address one ticket. Balance weighting entrenches whales; pure address sampling remains Sybil-sensitive. We mitigate Sybil gaming with a finalized precommitted snapshot and future-block seed, while acknowledging that no on-chain address rule proves personhood. */
export function makePlan(
  cycleId: string,
  snapshotBlock: number,
  anchorBlock: number,
  entries: Array<[string, bigint]>,
  seed: string,
  total: bigint,
  count: number,
): AirdropPlan {
  if (count < 1 || count > 10 || count > entries.length)
    throw new Error("invalid recipient count");
  const pool = [...entries],
    chosen: string[] = [];
  for (let i = 0; i < count; i++) {
    const j = draw(seed, i, pool.length);
    chosen.push(pool[j]![0]);
    pool.splice(j, 1);
  }
  const q = total / BigInt(count),
    rem = total % BigInt(count);
  return {
    version: 1,
    cycleId,
    snapshotBlock,
    anchorBlock,
    eligibleSetHash: eligibleCommitment(entries),
    seed,
    totalWeth: total.toString(),
    recipientCount: count,
    recipients: chosen.map((address, i) => ({
      address,
      amount: (q + (i === 0 ? rem : 0n)).toString(),
      status: "pending",
    })),
  };
}
export async function deriveSeed(
  ctx: Context,
  plan: Omit<AirdropPlan, "recipients" | "seed">,
): Promise<string> {
  const latest = await ctx.provider.getBlockNumber();
  if (latest < plan.anchorBlock + 12)
    throw new Error("randomness anchor not finalized");
  const b = await ctx.provider.getBlock(plan.anchorBlock);
  if (!b?.hash) throw new Error("anchor hash unavailable");
  return solidityPackedKeccak256(
    ["bytes32", "address", "uint256", "uint256", "bytes32", "bytes32"],
    [
      plan.cycleId,
      ctx.token,
      plan.snapshotBlock,
      plan.anchorBlock,
      plan.eligibleSetHash,
      b.hash,
    ],
  );
}
