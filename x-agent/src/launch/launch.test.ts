import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseLaunchCommand } from "./command.js";
import { LaunchInputError, validateMetadata } from "./interpreter.js";
import { LaunchService, type TokenLauncher } from "./service.js";
import type { LaunchMetadata } from "./types.js";
import { Wallet, hexlify, randomBytes } from "ethers";

test("launch command accepts one natural-language payload", () => {
  assert.deepEqual(
    parseLaunchCommand("@DCRagent /launch Name: Curved Cat | Ticker: CCAT", "DCRagent"),
    { kind: "launch", request: "Name: Curved Cat | Ticker: CCAT" }
  );
  assert.equal(parseLaunchCommand("hello @DCRagent", "DCRagent").kind, "ordinary");
  assert.equal(parseLaunchCommand("/launch", "DCRagent").kind, "invalid");
  assert.equal(parseLaunchCommand("/launch A /launch B", "DCRagent").kind, "invalid");
});

test("launch metadata enforces PONS name, ticker, description, and HTTPS rules", () => {
  assert.deepEqual(validateMetadata({
    name: "Curved Cat",
    symbol: "$ccat",
    description: "A discrete cat",
    website: "example.com"
  }), {
    name: "Curved Cat",
    symbol: "CCAT",
    description: "A discrete cat",
    website: "https://example.com/"
  });
  assert.throws(
    () => validateMetadata({ name: "Curved-Cat", symbol: "CCAT", description: null }),
    LaunchInputError
  );
  assert.throws(
    () => validateMetadata({ name: "Curved Cat", symbol: "TOO-LONG!", description: null }),
    LaunchInputError
  );
});

test("successful launch is durable, contains no raw key, and enforces one per 24h", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcr-launch-test-"));
  try {
    const metadata: LaunchMetadata = { name: "Curved Cat", symbol: "CCAT", description: "" };
    const interpreter = { interpret: async () => metadata };
    let calls = 0;
    const launcher: TokenLauncher = {
      async launch(wallet, supplied, _image, hooks) {
        calls += 1;
        await hooks.fundingPrepared({ hash: "0x" + "11".repeat(32), rawTx: "0x01", nonce: 1 });
        await hooks.funded();
        await hooks.launchPrepared({
          hash: "0x" + "22".repeat(32),
          rawTx: "0x02",
          nonce: 0,
          predictedTokenAddress: "0x" + "33".repeat(20)
        });
        return {
          tokenAddress: "0x" + "33".repeat(20),
          walletAddress: wallet.address,
          launchTxHash: "0x" + "22".repeat(32),
          launchBlock: 123,
          metadata: supplied
        };
      }
    };
    const service = new LaunchService({
      enabled: true,
      registryFile: join(root, "registry.json"),
      keystoreDir: join(root, "keys"),
      walletPassword: "a-strong-test-password-with-32-chars",
      fundingWei: 1_000_000_000_000_000n,
      imageUploadUrl: "https://example.invalid/upload",
      dashboardBaseUrl: "https://dcr-rh.tech",
      globalDailyLimit: 25
    }, interpreter, launcher);
    const mention = { id: "100", text: "/launch test", authorId: "42", username: "alice" };
    const first = await service.handle(mention, "test");
    assert.match(first, /CA: 0x3333333333333333333333333333333333333333/);
    assert.match(first, /dcr-rh\.tech\/token\/0x3333/);
    const second = await service.handle({ ...mention, id: "101" }, "test");
    assert.match(second, /One launch per X account every 24h/);
    assert.equal(calls, 1);

    const registry = await readFile(join(root, "registry.json"), "utf8");
    assert.doesNotMatch(registry, /privateKey|mnemonic|xpriv/i);
    const parsed = JSON.parse(registry) as { records: Array<{ stage: string; keystoreFile: string }> };
    assert.equal(parsed.records[0].stage, "launched");
    const keystore = await readFile(parsed.records[0].keystoreFile, "utf8");
    assert.match(keystore, /crypto/i);
    assert.doesNotMatch(keystore, /privateKey|mnemonic|xpriv/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery resumes the exact prepared funding record without creating another wallet", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcr-launch-recovery-"));
  const password = "another-strong-test-password-32-chars";
  try {
    const wallet = new Wallet(hexlify(randomBytes(32)));
    const keys = join(root, "keys");
    await mkdir(keys);
    const keystoreFile = join(keys, "pending.json");
    await writeFile(keystoreFile, await wallet.encrypt(password));
    const registryFile = join(root, "registry.json");
    await writeFile(registryFile, JSON.stringify({
      version: 1,
      records: [{
        id: "pending",
        requestTweetId: "777",
        authorId: "42",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stage: "funding_prepared",
        metadata: { name: "Recovered Cat", symbol: "RCAT", description: "" },
        walletAddress: wallet.address,
        keystoreFile,
        fundingWei: "1000000000000000",
        fundingTxHash: "0x" + "11".repeat(32),
        fundingRawTx: "0x01",
        fundingNonce: 9,
        launchSalt: "0x" + "44".repeat(32)
      }]
    }));
    let recoveredFundingHash = "";
    const launcher: TokenLauncher = {
      async launch(_wallet, metadata, _image, hooks, recovery) {
        recoveredFundingHash = recovery?.funding?.hash ?? "";
        await hooks.funded();
        await hooks.launchPrepared({
          hash: "0x" + "22".repeat(32), rawTx: "0x02", nonce: 0,
          predictedTokenAddress: "0x" + "33".repeat(20)
        });
        return {
          tokenAddress: "0x" + "33".repeat(20),
          walletAddress: wallet.address,
          launchTxHash: "0x" + "22".repeat(32),
          launchBlock: 456,
          metadata
        };
      }
    };
    const service = new LaunchService({
      enabled: true,
      registryFile,
      keystoreDir: keys,
      walletPassword: password,
      fundingWei: 1_000_000_000_000_000n,
      imageUploadUrl: "https://example.invalid/upload",
      dashboardBaseUrl: "https://dcr-rh.tech",
      globalDailyLimit: 25
    }, { interpret: async () => { throw new Error("not used"); } }, launcher);
    await service.recoverPending();
    assert.equal(recoveredFundingHash, "0x" + "11".repeat(32));
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as { records: Array<Record<string, unknown>> };
    assert.equal(registry.records[0].stage, "launched");
    assert.equal(registry.records[0].tokenAddress, "0x" + "33".repeat(20));
    assert.equal(registry.records[0].fundingRawTx, undefined);
    assert.equal(registry.records[0].launchRawTx, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
