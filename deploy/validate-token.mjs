import { createRequire } from "node:module";
import {
  discover,
  findDeploymentBlock
} from "../aristotle-output/input_aristotle/dist/chain.js";

const requireFromAgent = createRequire(
  new URL("../aristotle-output/input_aristotle/package.json", import.meta.url)
);
const { Contract, getAddress } = requireFromAgent("ethers");

const mode = process.argv[2];
const tokenInput = process.argv[3];
if (!["live", "dry-run"].includes(mode) || !tokenInput) {
  console.error("Usage: validate-token.mjs <live|dry-run> <token_address>");
  process.exit(64);
}

const rpc = process.env.RPC_URL;
const privateKey = process.env.CREATOR_PRIVATE_KEY;
if (!rpc || !privateKey) {
  console.error("RPC_URL and CREATOR_PRIVATE_KEY are required.");
  process.exit(78);
}

let context;
try {
  context = await discover(rpc, tokenInput, privateKey);
  const signer = getAddress(context.signer.address);
  const recipient = getAddress(context.recipient);
  if (mode === "live" && signer !== recipient) {
    throw new Error(
      `signer ${signer} is not the resolved fee recipient ${recipient}`
    );
  }

  const token = new Contract(
    context.token,
    [
      "function name() view returns(string)",
      "function symbol() view returns(string)"
    ],
    context.provider
  );
  const [name, symbol, deploymentBlock] = await Promise.all([
    token.name(),
    token.symbol(),
    findDeploymentBlock(context.provider, context.token)
  ]);
  console.log(JSON.stringify({
    chainId: 4663,
    token: context.token,
    name,
    symbol,
    pool: context.pool,
    deployer: context.deployer,
    feeRecipient: recipient,
    signer,
    signingAuthorized: signer === recipient,
    deploymentBlock,
    mode
  }));
} catch (error) {
  console.error(
    `Activation validation failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
} finally {
  context?.provider?.destroy();
}
