import {
  JsonRpcProvider,
  JsonRpcSigner,
} from "../aristotle-output/input_aristotle/node_modules/ethers/lib.esm/index.js";
import { discover } from "../aristotle-output/input_aristotle/dist/chain.js";
import { execute } from "../aristotle-output/input_aristotle/dist/executor.js";

const RPC = "http://127.0.0.1:18547";
const TOKEN = "0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a";
const CREATOR = "0xFe884239Ab22cA90BB86a33120aD932bd52339F1";

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });
await provider.send("anvil_setBalance", [CREATOR, "0x8ac7230489e80000"]);
await provider.send("anvil_impersonateAccount", [CREATOR]);

const signer = new JsonRpcSigner(provider, CREATOR);
const ctx = { ...(await discover(RPC, TOKEN)), signer };

console.error("PENDING_CHILD_STARTED");
const result = await execute(
  ctx,
  {
    kind: "buy",
    amount: 10_000_000_000_000n,
    score: 1n,
    reason: "fork pending crash",
  },
  true,
);
console.error("PENDING_CHILD_RESULT", JSON.stringify(result));
