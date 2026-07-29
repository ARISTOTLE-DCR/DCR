import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { balances, discover, observe, quote, simulateClaim } from "./chain.js";
import { PUBLIC_FIXTURE, RPC_DEFAULT } from "./constants.js";
import { collect, execute } from "./executor.js";
import { decide, initialState, nextDelayMs, type State } from "./math.js";

const token=process.env.TOKEN_ADDRESS; if(!token)throw new Error("TOKEN_ADDRESS is required; copy .env.example to .env");
const rpc=process.env.RPC_URL||RPC_DEFAULT, stateFile=process.env.STATE_FILE||"./data/state.json";
const once=process.argv.includes("--once"), requested=process.env.SIGNING_ENABLED==="true";
async function load():Promise<State>{try{return JSON.parse(await readFile(stateFile,"utf8")) as State;}catch{return initialState();}}
async function save(s:State):Promise<void>{await mkdir(dirname(stateFile),{recursive:true});const tmp=stateFile+".tmp";await writeFile(tmp,JSON.stringify(s,null,2));await rename(tmp,stateFile);}
async function cycle():Promise<void>{
 const ctx=await discover(rpc,token!,process.env.CREATOR_PRIVATE_KEY||undefined);
 const enabled=requested&&ctx.token.toLowerCase()!==PUBLIC_FIXTURE.toLowerCase();
 if(requested&&!enabled)console.warn("Signing blocked for the public integration fixture.");
 const state=await load(); const [obs,bal,claim]=await Promise.all([observe(ctx,state.lastBlock+1),balances(ctx),simulateClaim(ctx)]);
 const action=decide(obs,state,bal.weth,bal.token,ctx.tokenIs0);
 let quoteOut:string|undefined;if(action.kind==="buy"||action.kind==="sell"){try{quoteOut=(await quote(ctx,action)).toString();}catch(e){quoteOut=`unavailable: ${String(e).slice(0,120)}`;}}
 console.log(JSON.stringify({mode:enabled?"signing":"dry-run",chainId:4663,token:ctx.token,pool:ctx.pool,deployer:ctx.deployer,feeRecipient:ctx.recipient,protocolFeeShare:ctx.protocolFeeShare.toString(),observation:{...obs,sqrtPriceX96:obs.sqrtPriceX96.toString(),liquidity:obs.liquidity.toString(),volumeWeth:obs.volumeWeth.toString()},balances:{weth:bal.weth.toString(),token:bal.token.toString()},feeClaimSimulation:claim,decision:{...action,amount:"amount" in action?action.amount.toString():undefined,score:"score" in action?action.score.toString():undefined},quoteOut},null,2));
 if(enabled){console.log("collection",await collect(ctx));console.log("execution",await execute(ctx,action,true));}
 await save({...state,lastBlock:obs.block,lastTimestamp:obs.timestamp,lastSqrtPriceX96:obs.sqrtPriceX96.toString(),reserveWeth:bal.weth.toString(),reserveToken:bal.token.toString(),integral:(BigInt(state.integral)+obs.volumeWeth).toString(),lastActionAt:action.kind==="hold"?state.lastActionAt:Date.now()});
}
async function main(){do{try{await cycle();}catch(e){console.error("cycle failed safely; future cycles continue:",e);}if(once)break;const ms=nextDelayMs();console.log(`next cycle in ${(ms/60000).toFixed(2)} minutes`);await new Promise(r=>setTimeout(r,ms));}while(true);}
await main();
