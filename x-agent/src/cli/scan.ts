import "dotenv/config";
import { getAddress, isAddress } from "ethers";
import { ScanFailure, TokenScanner } from "../scan/scanner.js";

const value = process.argv[2];
if (!value || !isAddress(value)) {
  console.error("Invalid address. Usage: npm run scan -- 0xTokenAddress");
  process.exitCode = 2;
} else {
  const scanner = new TokenScanner({ rpcUrl: process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com" });
  try {
    const report = await scanner.scan(getAddress(value));
    console.log(report.text);
    console.log(JSON.stringify({ token: report.token, pool: report.pool, finalizedBlock: report.finalizedBlock, priceWeth: report.price, swaps: report.swaps, score: report.result.score, confidence: report.result.confidence }, null, 2));
  } catch (error) {
    console.error(error instanceof ScanFailure ? `${error.category}: ${error.message}` : "rpc_unavailable: scan failed safely");
    process.exitCode = 1;
  }
}
