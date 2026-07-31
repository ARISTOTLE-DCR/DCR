import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BaseWallet, Wallet, hexlify, randomBytes } from "ethers";
import type { Mention } from "../types.js";
import { logger } from "../logger.js";
import type { LaunchInterpreterLike } from "./interpreter.js";
import { LaunchInputError } from "./interpreter.js";
import { ImageUploadError, uploadPonsImage } from "./image.js";
import type {
  LaunchRecovery,
  LaunchTransactionHooks,
  PonsOnchainLauncher
} from "./onchain.js";
import { LaunchBudgetError } from "./onchain.js";
import { LaunchRegistry } from "./registry.js";
import type { LaunchRecord, LaunchResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type LaunchServiceConfig = {
  enabled: boolean;
  registryFile: string;
  keystoreDir: string;
  walletPassword: string;
  fundingWei: bigint;
  imageUploadUrl: string;
  dashboardBaseUrl: string;
  globalDailyLimit: number;
};

export interface TokenLauncher {
  launch(
    wallet: BaseWallet,
    metadata: LaunchRecord["metadata"],
    imageUri: string,
    hooks: LaunchTransactionHooks,
    recovery?: LaunchRecovery
  ): Promise<LaunchResult>;
}

export class LaunchService {
  private tail: Promise<void> = Promise.resolve();
  private readonly registry: LaunchRegistry;

  constructor(
    private readonly config: LaunchServiceConfig,
    private readonly interpreter: LaunchInterpreterLike,
    private readonly launcher: Pick<PonsOnchainLauncher, "launch"> | TokenLauncher
  ) {
    this.registry = new LaunchRegistry(config.registryFile);
  }

  handle(mention: Mention, request: string): Promise<string> {
    if (!this.config.enabled) return Promise.resolve("Token launches are configured but not enabled yet.");
    return this.enqueue(() => this.execute(mention, request));
  }

  async recoverPending(): Promise<void> {
    if (!this.config.enabled) return;
    await this.enqueue(async () => {
      const records = (await this.registry.read()).records;
      for (let record of records) {
        if (["launched", "failed_before_funding", "failed_after_funding"].includes(record.stage)) continue;
        if (record.stage === "reserved" || !record.keystoreFile || !record.walletAddress || !record.launchSalt) {
          await this.registry.update(record.id, { stage: "failed_before_funding", error: "RecoveryError: incomplete pre-funding record" });
          continue;
        }
        try {
          const wallet = await Wallet.fromEncryptedJson(await readFile(record.keystoreFile, "utf8"), this.config.walletPassword);
          if (wallet.address.toLowerCase() !== record.walletAddress.toLowerCase()) throw new Error("Encrypted wallet address mismatch.");
          const hooks = this.hooks(record.id, (next) => { record = next; });
          const result = await this.launcher.launch(
            wallet,
            record.metadata,
            record.imageUri ?? "",
            hooks,
            recoveryFrom(record)
          );
          await this.complete(record.id, result);
          logger.info("Recovered pending PONS launch", { tweetId: record.requestTweetId, tokenAddress: result.tokenAddress });
        } catch (error) {
          await this.fail(record, error);
        }
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async execute(mention: Mention, request: string): Promise<string> {
    const prior = await this.registry.findByTweetId(mention.id);
    if (prior) {
      if (prior.stage === "launched" && prior.tokenAddress && prior.walletAddress && prior.launchTxHash && prior.launchBlock) {
        return launchReply(resultFromRecord(prior), this.config.dashboardBaseUrl);
      }
      if (prior.stage === "failed_before_funding") return "The previous launch attempt stopped before funding. Send a new /launch post to retry.";
      if (prior.stage === "failed_after_funding") return "The launch stopped after wallet funding. It is isolated for operator recovery; no duplicate transaction will be sent.";
      return "This launch is still being reconciled. No duplicate transaction will be sent.";
    }

    const since = Date.now() - DAY_MS;
    const recent = await this.registry.recentForAuthor(mention.authorId, since);
    if (recent) {
      const retryAt = new Date(Date.parse(recent.createdAt) + DAY_MS).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      return `One launch per X account every 24h. Your next launch is available after ${retryAt}.`;
    }
    if (await this.registry.countRecent(since) >= this.config.globalDailyLimit) {
      return "The network-wide daily launch budget is full. Try again after the rolling 24h window advances.";
    }

    let metadata: LaunchRecord["metadata"];
    try {
      metadata = await this.interpreter.interpret(request);
    } catch (error) {
      if (error instanceof LaunchInputError) return error.message;
      throw error;
    }

    let imageUri = "";
    try {
      const imageUrl = mention.images?.[0]?.url;
      if (imageUrl) imageUri = await uploadPonsImage(imageUrl, this.config.imageUploadUrl);
    } catch (error) {
      if (error instanceof ImageUploadError) return `Launch stopped before funding: ${error.message}`;
      return "Launch stopped before funding because the attached image could not be verified.";
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    let record: LaunchRecord = {
      id,
      requestTweetId: mention.id,
      authorId: mention.authorId,
      username: mention.username,
      createdAt: now,
      updatedAt: now,
      stage: "reserved",
      metadata,
      imageUri: imageUri || undefined,
      fundingWei: this.config.fundingWei.toString(),
      launchSalt: hexlify(randomBytes(32))
    };
    await this.registry.insert(record);

    try {
      const wallet = new Wallet(hexlify(randomBytes(32)));
      await mkdir(this.config.keystoreDir, { recursive: true, mode: 0o700 });
      const keystoreFile = join(this.config.keystoreDir, `${id}.json`);
      await writeFile(keystoreFile, await wallet.encrypt(this.config.walletPassword), { mode: 0o640 });
      record = await this.registry.update(id, {
        stage: "wallet_created",
        walletAddress: wallet.address,
        keystoreFile
      });
      const result = await this.launcher.launch(
        wallet,
        metadata,
        imageUri,
        this.hooks(id, (next) => { record = next; }),
        { salt: record.launchSalt }
      );
      await this.complete(id, result);
      logger.info("PONS token launched", { tweetId: mention.id, authorId: mention.authorId, tokenAddress: result.tokenAddress, walletAddress: result.walletAddress });
      return launchReply(result, this.config.dashboardBaseUrl);
    } catch (error) {
      await this.fail(record, error);
      if (error instanceof LaunchBudgetError) return error.message;
      const afterFunding = fundedOrPrepared(record);
      return afterFunding
        ? "Launch did not complete after wallet funding. Funds remain isolated; the operator has been alerted and no duplicate launch will be sent."
        : "Launch stopped safely before funding. Please verify the fields and try again later.";
    }
  }

  private hooks(id: string, updateLocal: (record: LaunchRecord) => void): LaunchTransactionHooks {
    return {
      fundingPrepared: async (transaction) => {
        const record = await this.registry.update(id, {
          stage: "funding_prepared",
          fundingTxHash: transaction.hash,
          fundingRawTx: transaction.rawTx,
          fundingNonce: transaction.nonce
        });
        updateLocal(record);
      },
      funded: async () => {
        const record = await this.registry.update(id, { stage: "funded" });
        updateLocal(record);
      },
      launchPrepared: async (transaction) => {
        const record = await this.registry.update(id, {
          stage: "launch_prepared",
          launchTxHash: transaction.hash,
          launchRawTx: transaction.rawTx,
          launchNonce: transaction.nonce,
          predictedTokenAddress: transaction.predictedTokenAddress
        });
        updateLocal(record);
      }
    };
  }

  private async complete(id: string, result: LaunchResult): Promise<void> {
    await this.registry.update(id, {
      stage: "launched",
      tokenAddress: result.tokenAddress,
      walletAddress: result.walletAddress,
      launchTxHash: result.launchTxHash,
      launchBlock: result.launchBlock,
      fundingRawTx: undefined,
      launchRawTx: undefined,
      error: undefined
    });
  }

  private async fail(record: LaunchRecord, error: unknown): Promise<void> {
    const afterFunding = fundedOrPrepared(record);
    const storedError = error instanceof LaunchBudgetError || error instanceof ImageUploadError
      ? `${error.name}: ${error.message}`.slice(0, 500)
      : `${error instanceof Error ? error.name : "Error"}: launch failed safely`;
    await this.registry.update(record.id, {
      stage: afterFunding ? "failed_after_funding" : "failed_before_funding",
      error: storedError
    });
    logger.error("PONS launch failed safely", {
      tweetId: record.requestTweetId,
      authorId: record.authorId,
      stage: record.stage,
      errorType: error instanceof Error ? error.name : "unknown"
    });
  }
}

function recoveryFrom(record: LaunchRecord): LaunchRecovery {
  const funding = record.fundingTxHash && record.fundingRawTx && record.fundingNonce !== undefined
    ? { hash: record.fundingTxHash, rawTx: record.fundingRawTx, nonce: record.fundingNonce }
    : undefined;
  const launch = record.launchTxHash && record.launchRawTx && record.launchNonce !== undefined && record.predictedTokenAddress
    ? { hash: record.launchTxHash, rawTx: record.launchRawTx, nonce: record.launchNonce, predictedTokenAddress: record.predictedTokenAddress }
    : undefined;
  return {
    salt: record.launchSalt,
    fundingConfirmed: ["funded", "launch_prepared", "launch_submitted"].includes(record.stage),
    funding: record.stage === "funding_prepared" ? funding : undefined,
    launch
  };
}

function fundedOrPrepared(record: LaunchRecord): boolean {
  return ["funding_prepared", "funding_submitted", "funded", "launch_prepared", "launch_submitted"].includes(record.stage);
}

function resultFromRecord(record: LaunchRecord): LaunchResult {
  return {
    tokenAddress: record.tokenAddress!,
    walletAddress: record.walletAddress!,
    launchTxHash: record.launchTxHash!,
    launchBlock: record.launchBlock!,
    metadata: record.metadata
  };
}

export function launchReply(result: LaunchResult, dashboardBaseUrl: string): string {
  const base = dashboardBaseUrl.replace(/\/$/, "");
  return `Launched ${result.metadata.name} ($${result.metadata.symbol}) on PONS.\nCA: ${result.tokenAddress}\nAutonomous fee strategy: ${base}/token/${result.tokenAddress}`;
}
