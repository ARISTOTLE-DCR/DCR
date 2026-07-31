import { Contract, parseEther } from "ethers";
import type { Context } from "./chain.js";
import { ABIS, WETH } from "./constants.js";
import { sendBuffered, settlePrepared } from "./executor.js";
import type { Store, GasPlan } from "./store.js";

export const GAS_NATIVE_MINIMUM = parseEther("0.0002");
export const GAS_NATIVE_TARGET = parseEther("0.0005");

export function gasTopUpAmount(
  nativeBalance: bigint,
  wethBalance: bigint,
  minimum = GAS_NATIVE_MINIMUM,
  target = GAS_NATIVE_TARGET,
): bigint {
  if (nativeBalance >= minimum || wethBalance === 0n) return 0n;
  const required = target > nativeBalance ? target - nativeBalance : 0n;
  return required < wethBalance ? required : wethBalance;
}

export async function ensureGasReserve(
  ctx: Context,
  store: Store,
  enabled: boolean,
): Promise<{ status: "disabled" | "sufficient" | "empty" | "confirmed"; amountWeth?: string; txHash?: string }> {
  if (!enabled || !ctx.signer) return { status: "disabled" };

  let existing = await store.gasPlan();
  if (existing?.stage === "prepared" && existing.txHash) {
    const receipt = await settlePrepared(ctx, {
      hash: existing.txHash,
      nonce: existing.nonce ?? 0,
      rawTx: existing.rawTx,
    });
    if (!receipt) throw new Error("WETH gas top-up remains pending");
    existing = {
      ...existing,
      stage: receipt.status === 1 ? "confirmed" : "failed",
      error: receipt.status === 1 ? undefined : "WETH gas top-up reverted",
      updatedAt: Date.now(),
    };
    await store.saveGasPlan(existing);
    if (existing.stage === "failed") throw new Error(existing.error);
  }

  const weth: any = new Contract(WETH, ABIS.token, ctx.signer);
  const [nativeBalance, wethBalance] = await Promise.all([
    ctx.provider.getBalance(ctx.signer.address),
    weth.balanceOf(ctx.signer.address) as Promise<bigint>,
  ]);
  const amount = gasTopUpAmount(nativeBalance, wethBalance);
  if (amount === 0n) {
    return nativeBalance >= GAS_NATIVE_MINIMUM
      ? { status: "sufficient" }
      : { status: "empty" };
  }

  let plan: GasPlan = {
    stage: "planned",
    amountWeth: amount.toString(),
    updatedAt: Date.now(),
  };
  await store.saveGasPlan(plan);
  const receipt = await sendBuffered(weth, "withdraw", [amount], async (transaction) => {
    plan = {
      ...plan,
      stage: "prepared",
      txHash: transaction.hash,
      rawTx: transaction.rawTx,
      nonce: transaction.nonce,
      updatedAt: Date.now(),
    };
    await store.saveGasPlan(plan);
  });
  plan = {
    ...plan,
    stage: "confirmed",
    txHash: receipt.hash,
    updatedAt: Date.now(),
  };
  await store.saveGasPlan(plan);
  return { status: "confirmed", amountWeth: amount.toString(), txHash: receipt.hash };
}
