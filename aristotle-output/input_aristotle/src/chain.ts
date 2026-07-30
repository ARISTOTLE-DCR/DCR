import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
} from "ethers";
import {
  ABIS,
  CHAIN_ID,
  FACTORY,
  LOCKER,
  QUOTER,
  ROUTER,
  V3_FACTORY,
  WETH,
} from "./constants.js";
import type { Observation, Action } from "./math.js";

export interface Context {
  provider: JsonRpcProvider;
  token: string;
  pool: string;
  fee: number;
  tokenIs0: boolean;
  deployer: string;
  recipient: string;
  protocolFeeShare: bigint;
  launchPositionId: bigint;
  signer?: Wallet;
}
export async function discover(
  rpc: string,
  tokenInput: string,
  privateKey?: string,
): Promise<Context> {
  const provider = new JsonRpcProvider(rpc, Number(CHAIN_ID), {
    staticNetwork: true,
  });
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID)
    throw new Error(`wrong chain ${network.chainId}, expected ${CHAIN_ID}`);
  const token = getAddress(tokenInput);
  const f: any = new Contract(FACTORY, ABIS.factory, provider);
  if (getAddress(await f.locker()) !== getAddress(LOCKER))
    throw new Error("factory locker identity mismatch");
  const launch = await f.getLaunchedToken(token);
  if (!launch.exists) throw new Error("token is not a PONS launch");
  if (
    getAddress(launch.token) !== token ||
    getAddress(launch.pairedToken) !== getAddress(WETH)
  )
    throw new Error("launch metadata mismatch");
  const t: any = new Contract(token, ABIS.token, provider);
  if (getAddress(await t.launchFactory()) !== getAddress(FACTORY))
    throw new Error("token factory mismatch");
  const vf: any = new Contract(V3_FACTORY, ABIS.v3factory, provider);
  const pool = getAddress(await vf.getPool(token, WETH, launch.poolFee));
  if (pool === ZeroAddress || getAddress(await t.liquidityPool()) !== pool)
    throw new Error("canonical pool mismatch");
  const p: any = new Contract(pool, ABIS.pool, provider);
  const token0 = getAddress(await p.token0());
  const token1 = getAddress(await p.token1());
  if (
    !(
      [token0, token1].includes(token) &&
      [token0, token1].includes(getAddress(WETH))
    )
  )
    throw new Error("pool asset mismatch");
  const l: any = new Contract(LOCKER, ABIS.locker, provider);
  const [redirectRaw, protocolFeeShare] = await Promise.all([
    l.feeRedirects(token),
    l.tokenProtocolFeeShares(token),
  ]);
  const redirect = getAddress(redirectRaw);
  const recipient =
    redirect === ZeroAddress ? getAddress(launch.deployer) : redirect;
  const { POSITION_MANAGER } = await import("./constants.js");
  if (getAddress(launch.positionManager) !== getAddress(POSITION_MANAGER))
    throw new Error("position manager identity mismatch");
  const ctx: Context = {
    provider,
    token,
    pool,
    fee: Number(launch.poolFee),
    tokenIs0: token0 === token,
    deployer: getAddress(launch.deployer),
    recipient,
    protocolFeeShare,
    launchPositionId: BigInt(launch.positionId),
  };
  if (privateKey) {
    const signer = new Wallet(privateKey, provider);
    return { ...ctx, signer };
  }
  return ctx;
}
export async function observe(
  ctx: Context,
  fromBlock: number,
): Promise<Observation> {
  const latest = await ctx.provider.getBlock("latest");
  if (!latest) throw new Error("latest block unavailable");
  const start = Math.max(fromBlock || latest.number - 500, latest.number - 500);
  const pool: any = new Contract(ctx.pool, ABIS.pool, ctx.provider);
  const [slot, liq, spacing, logs] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.tickSpacing(),
    ctx.provider.getLogs({
      address: ctx.pool,
      fromBlock: start,
      toBlock: latest.number,
      topics: [new Interface(ABIS.pool).getEvent("Swap")!.topicHash],
    }),
  ]);
  const iface = new Interface(ABIS.pool);
  let volume = 0n;
  for (const log of logs) {
    const x = iface.parseLog(log);
    if (!x) continue;
    const a0 = x.args.amount0 as bigint,
      a1 = x.args.amount1 as bigint;
    volume += ctx.tokenIs0 ? (a1 < 0n ? -a1 : a1) : a0 < 0n ? -a0 : a0;
  }
  return {
    block: latest.number,
    timestamp: latest.timestamp,
    sqrtPriceX96: slot[0] as bigint,
    tick: Number(slot[1]),
    tickSpacing: Number(spacing),
    liquidity: liq as bigint,
    volumeWeth: volume,
    swapCount: logs.length,
  };
}
export async function balances(
  ctx: Context,
): Promise<{ weth: bigint; token: bigint }> {
  const who = ctx.recipient;
  const wc: any = new Contract(WETH, ABIS.token, ctx.provider),
    tc: any = new Contract(ctx.token, ABIS.token, ctx.provider);
  const [weth, token] = await Promise.all([
    wc.balanceOf(who),
    tc.balanceOf(who),
  ]);
  return { weth, token };
}

export async function findDeploymentBlock(
  provider: JsonRpcProvider,
  token: string,
): Promise<number> {
  let low = 0;
  let high = await provider.getBlockNumber();
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await provider.getCode(token, middle)) === "0x") low = middle + 1;
    else high = middle;
  }
  if ((await provider.getCode(token, low)) === "0x")
    throw new Error("token deployment block could not be discovered");
  return low;
}

export async function validateDeploymentBlock(
  provider: JsonRpcProvider,
  token: string,
  block: number,
): Promise<number> {
  if (!Number.isSafeInteger(block) || block <= 0)
    throw new Error("TOKEN_LAUNCH_BLOCK must be a positive integer");
  const [at, before] = await Promise.all([
    provider.getCode(token, block),
    provider.getCode(token, block - 1),
  ]);
  if (at === "0x" || before !== "0x")
    throw new Error(
      `TOKEN_LAUNCH_BLOCK ${block} is not the token deployment block`,
    );
  return block;
}
export async function simulateClaim(ctx: Context): Promise<string> {
  const caller = ctx.signer?.address ?? ctx.deployer;
  const locker: any = new Contract(LOCKER, ABIS.locker, ctx.provider);
  try {
    await locker.collectFees.staticCall(ctx.token, { from: caller });
    return "claimable";
  } catch (e) {
    const s = String(e);
    return s.includes("NoFeesToCollect") || s.includes("0xd0d04f60")
      ? "none"
      : "unavailable/not authorized";
  }
}
export async function quote(
  ctx: Context,
  action: Extract<Action, { amount: bigint }>,
): Promise<bigint> {
  const tokenIn = action.kind === "buy" ? WETH : ctx.token,
    tokenOut = action.kind === "buy" ? ctx.token : WETH;
  const q: any = new Contract(QUOTER, ABIS.quoter, ctx.provider);
  const result = await q.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    amountIn: action.amount,
    fee: ctx.fee,
    sqrtPriceLimitX96: 0,
  });
  return result.amountOut;
}
