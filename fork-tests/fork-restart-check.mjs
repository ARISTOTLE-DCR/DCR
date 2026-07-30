import {
  Contract,
  JsonRpcProvider,
} from "../aristotle-output/input_aristotle/node_modules/ethers/lib.esm/index.js";
import {
  balances,
  discover,
  observe,
} from "../aristotle-output/input_aristotle/dist/chain.js";
import {
  decide,
  initialState,
} from "../aristotle-output/input_aristotle/dist/math.js";
import {
  ABIS,
} from "../aristotle-output/input_aristotle/dist/constants.js";

const RPC = "http://127.0.0.1:18547";
const TOKEN = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const PRE_SWAP_BLOCK = 22414286;
const SWAP_BLOCK = 22414287;

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const ctx = await discover(RPC, TOKEN);
const pool = new Contract(ctx.pool, ABIS.pool, provider);
const preSwapSlot = await pool.slot0({ blockTag: PRE_SWAP_BLOCK });
const observation = await observe(ctx, SWAP_BLOCK);
const walletBalances = await balances(ctx);
const state = {
  ...initialState(),
  lastBlock: PRE_SWAP_BLOCK,
  lastSqrtPriceX96: preSwapSlot[0].toString(),
};
const action = decide(
  observation,
  state,
  walletBalances.weth,
  walletBalances.token,
  ctx.tokenIs0,
);

console.log(
  JSON.stringify(
    {
      preSwapBlock: PRE_SWAP_BLOCK,
      swapBlock: SWAP_BLOCK,
      observedSwapCount: observation.swapCount,
      observedVolumeWeth: observation.volumeWeth.toString(),
      preSwapSqrtPriceX96: preSwapSlot[0].toString(),
      postSwapSqrtPriceX96: observation.sqrtPriceX96.toString(),
      restartDecision: {
        ...action,
        amount: "amount" in action ? action.amount.toString() : undefined,
        score: "score" in action ? action.score.toString() : undefined,
      },
    },
    null,
    2,
  ),
);
