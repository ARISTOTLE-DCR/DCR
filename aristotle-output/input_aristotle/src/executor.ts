import { Contract, TransactionReceipt, getAddress } from "ethers";
import { ABIS, BPS, BURN, LOCKER, ROUTER, WETH } from "./constants.js";
import type { Context } from "./chain.js";
import type { Action } from "./math.js";
import { quote } from "./chain.js";

export interface ExecutionResult { status:"skipped"|"confirmed"|"failed"; detail:string; txHash?:string; }
async function receiptOf(tx: any):Promise<TransactionReceipt>{
 try { const r=await tx.wait(2,180_000); if(!r||r.status!==1)throw new Error("transaction reverted"); return r; }
 catch(e:any){ if(e?.replacement){const r=await e.replacement.wait(2);if(r?.status===1)return r;} throw e; }
}
export async function collect(ctx:Context):Promise<ExecutionResult>{
 if(!ctx.signer)return {status:"skipped",detail:"non-signing mode"};
 const c:any=new Contract(LOCKER,ABIS.locker,ctx.signer);
 try { await c.collectFees.staticCall(ctx.token); const tx=await c.collectFees(ctx.token); const r=await receiptOf(tx); return {status:"confirmed",detail:"creator fees collected and receipt confirmed",txHash:r.hash}; }
 catch(e){const s=String(e);if(s.includes("NoFeesToCollect")||s.includes("0xd0d04f60"))return {status:"skipped",detail:"no fees currently claimable"};return {status:"failed",detail:`fee collection failed safely: ${s.slice(0,240)}`};}
}
export async function execute(ctx:Context,action:Action,enabled:boolean):Promise<ExecutionResult>{
 if(action.kind==="hold")return {status:"skipped",detail:action.reason};
 if(!enabled||!ctx.signer)return {status:"skipped",detail:`dry-run ${action.kind} ${action.amount}`};
 if(getAddress(ctx.signer.address)!==getAddress(ctx.recipient))return {status:"failed",detail:"signer is not resolved fee recipient; refusing to spend another wallet's reservoir"};
 if(action.amount<=0n)return {status:"failed",detail:"invalid zero amount"};
 const asset=action.kind==="buy"?WETH:ctx.token; const erc:any=new Contract(asset,ABIS.token,ctx.signer);
 const beforeIn:bigint=await erc.balanceOf(ctx.signer.address);
 if(action.amount>beforeIn)return {status:"failed",detail:"amount exceeds reconciled balance"};
 if(action.kind==="burn"){
  try{await erc.transfer.staticCall(BURN,action.amount);const tx=await erc.transfer(BURN,action.amount);const r=await receiptOf(tx);const after:bigint=await erc.balanceOf(ctx.signer.address);if(beforeIn-after!==action.amount)throw new Error("burn balance reconciliation failed");return {status:"confirmed",detail:"burn confirmed and reconciled",txHash:r.hash};}catch(e){return {status:"failed",detail:`burn failed safely: ${String(e).slice(0,240)}`};}
 }
 try{
  const expected=await quote(ctx,action); if(expected<=0n)throw new Error("zero quote"); const minOut=expected*(BPS-75n)/BPS;
  const outAsset:any=new Contract(action.kind==="buy"?ctx.token:WETH,ABIS.token,ctx.provider); const beforeOut:bigint=await outAsset.balanceOf(ctx.signer.address);
  const allowance:bigint=await erc.allowance(ctx.signer.address,ROUTER);
  if(allowance!==0n){await erc.approve.staticCall(ROUTER,0n);await receiptOf(await erc.approve(ROUTER,0n));}
  await erc.approve.staticCall(ROUTER,action.amount); await receiptOf(await erc.approve(ROUTER,action.amount));
  const router:any=new Contract(ROUTER,ABIS.router,ctx.signer); const params={tokenIn:asset,tokenOut:action.kind==="buy"?ctx.token:WETH,fee:ctx.fee,recipient:ctx.signer.address,amountIn:action.amount,amountOutMinimum:minOut,sqrtPriceLimitX96:0};
  await router.exactInputSingle.staticCall(params); const r=await receiptOf(await router.exactInputSingle(params));
  const [afterIn,afterOut]=await Promise.all([erc.balanceOf(ctx.signer.address),outAsset.balanceOf(ctx.signer.address)]);
  if(beforeIn-afterIn!==action.amount||afterOut-beforeOut<minOut)throw new Error("swap balance reconciliation failed");
  const remaining:bigint=await erc.allowance(ctx.signer.address,ROUTER);if(remaining!==0n){await erc.approve.staticCall(ROUTER,0n);await receiptOf(await erc.approve(ROUTER,0n));}
  return {status:"confirmed",detail:`swap confirmed; received ${afterOut-beforeOut}`,txHash:r.hash};
 }catch(e){
  try{const a:bigint=await erc.allowance(ctx.signer.address,ROUTER);if(a!==0n)await receiptOf(await erc.approve(ROUTER,0n));}catch{/* next cycle revalidates and clears */}
  return {status:"failed",detail:`swap failed safely: ${String(e).slice(0,240)}`};
 }
}
