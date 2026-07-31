import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { AristotleReasoner } from "./reasoner.js";
import { loadState, markProcessed, saveState } from "./state.js";
import { TwitterClient } from "./twitter.js";
import { TokenScanner } from "./scan/scanner.js";
import { MentionHandler } from "./mention-handler.js";
import { processMentions, StateWriteQueue } from "./mention-processor.js";
import { LaunchInterpreter } from "./launch/interpreter.js";
import { PonsOnchainLauncher } from "./launch/onchain.js";
import { LaunchService } from "./launch/service.js";

const config = loadConfig();
const state = await loadState(config.STATE_FILE);
const twitter = new TwitterClient(config);
const reasoner = new AristotleReasoner(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, config.BOT_HANDLE);
const scanner = new TokenScanner({ rpcUrl: config.ROBINHOOD_RPC_URL, timeoutMs: config.SCAN_TIMEOUT_MS, confirmations: config.SCAN_CONFIRMATIONS, cacheTtlMs: config.SCAN_CACHE_TTL_MS, maxConcurrent: config.SCAN_MAX_CONCURRENT });
const launchInterpreter = new LaunchInterpreter(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
const onchainLauncher = new PonsOnchainLauncher({
  rpcUrl: config.ROBINHOOD_RPC_URL,
  factoryAddress: config.PONS_FACTORY_ADDRESS,
  funderPrivateKey: config.LAUNCH_FUNDER_PRIVATE_KEY ?? "0x" + "00".repeat(32),
  fundingWei: BigInt(config.LAUNCH_FUNDING_WEI),
  funderMinimumRemainingWei: BigInt(config.LAUNCH_FUNDER_MIN_REMAINING_WEI),
  launchConfigId: BigInt(config.PONS_LAUNCH_CONFIG_ID),
  dexId: BigInt(config.PONS_DEX_ID),
  confirmations: config.LAUNCH_CONFIRMATIONS
});
const launchService = new LaunchService({
  enabled: config.LAUNCH_ENABLED,
  registryFile: config.LAUNCH_REGISTRY_FILE,
  keystoreDir: config.LAUNCH_KEYSTORE_DIR,
  walletPassword: config.LAUNCH_WALLET_PASSWORD ?? "disabled-launch-wallet-password",
  fundingWei: BigInt(config.LAUNCH_FUNDING_WEI),
  imageUploadUrl: config.PONS_IMAGE_UPLOAD_URL,
  dashboardBaseUrl: config.LAUNCH_DASHBOARD_BASE_URL,
  globalDailyLimit: config.LAUNCH_GLOBAL_DAILY_LIMIT
}, launchInterpreter, onchainLauncher);
const handler = new MentionHandler(config.BOT_HANDLE, reasoner, scanner, launchService);
const stateWrites = new StateWriteQueue((snapshot) => saveState(config.STATE_FILE, snapshot));

for (const notice of await launchService.recoverPending()) {
  try {
    await twitter.reply(notice.tweetId, notice.reply);
    logger.info("Published recovered PONS launch", { tweetId: notice.tweetId });
  } catch (error) {
    const candidate = error as { name?: unknown; code?: unknown; data?: { status?: unknown; detail?: unknown } };
    logger.warn("Recovered PONS launch could not be published to the original post", {
      tweetId: notice.tweetId,
      errorType: typeof candidate?.name === "string" ? candidate.name : "unknown",
      errorCode: typeof candidate?.code === "number" || typeof candidate?.code === "string" ? candidate.code : undefined,
      status: candidate?.data?.status,
      detail: typeof candidate?.data?.detail === "string" ? candidate.data.detail.slice(0, 200) : undefined
    });
  }
}

let firstPoll = !state.sinceId;
let stopping = false;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info("Aristotle bot started", {
  botHandle: config.BOT_HANDLE,
  botUserId: config.BOT_USER_ID,
  stateFile: config.STATE_FILE,
  sinceId: state.sinceId
});

while (!stopping) {
  await pollOnce();
  await sleep(config.POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  try {
    const { mentions, newestId } = await twitter.getMentions(state.sinceId);

    if (firstPoll && !config.PROCESS_EXISTING_MENTIONS) {
      firstPoll = false;
      for (const mention of mentions) markProcessed(state, mention.id);
      state.sinceId = newestId ?? state.sinceId;
      await saveState(config.STATE_FILE, state);
      logger.info("Skipped existing mentions on startup", { count: mentions.length, sinceId: state.sinceId });
      return;
    }

    firstPoll = false;

    await processMentions(mentions, newestId, state, handler, twitter, stateWrites);
  } catch (error) {
    logger.error("Poll failed", error);
  }
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
