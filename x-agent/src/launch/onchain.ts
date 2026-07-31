import {
  BaseWallet,
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  type TransactionRequest,
  type TransactionReceipt
} from "ethers";
import type { LaunchMetadata, LaunchResult } from "./types.js";
import { withNonceLock } from "./nonce-lock.js";

const CHAIN_ID = 4663;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const FACTORY_ABI = [
  "function launchFee() view returns(uint256)",
  "function launchEnabled() view returns(bool)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address feeWallet) params,uint256 launchConfigId,uint256 dexId,bytes32 salt) payable returns(address token)",
  "function getLaunchedToken(address) view returns(tuple(address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount))"
];

export type OnchainLaunchConfig = {
  rpcUrl: string;
  factoryAddress: string;
  funderPrivateKey: string;
  fundingWei: bigint;
  funderMinimumRemainingWei: bigint;
  launchConfigId: bigint;
  dexId: bigint;
  confirmations: number;
};

export type LaunchTransactionHooks = {
  fundingPrepared(transaction: PreparedLaunchTransaction): Promise<void>;
  funded(): Promise<void>;
  launchPrepared(transaction: PreparedLaunchTransaction & { predictedTokenAddress: string }): Promise<void>;
};

export type PreparedLaunchTransaction = {
  hash: string;
  rawTx: string;
  nonce: number;
};

export type LaunchRecovery = {
  salt?: string;
  fundingConfirmed?: boolean;
  funding?: PreparedLaunchTransaction;
  launch?: PreparedLaunchTransaction & { predictedTokenAddress: string };
};

export class LaunchBudgetError extends Error {}

export class PonsOnchainLauncher {
  constructor(private readonly config: OnchainLaunchConfig) {}

  async launch(
    wallet: BaseWallet,
    metadata: LaunchMetadata,
    imageUri: string,
    hooks: LaunchTransactionHooks,
    recovery: LaunchRecovery = {}
  ): Promise<LaunchResult> {
    const provider = new JsonRpcProvider(this.config.rpcUrl, CHAIN_ID, { staticNetwork: true });
    try {
      const funder = new Wallet(this.config.funderPrivateKey, provider);
      const factoryRead: any = new Contract(this.config.factoryAddress, FACTORY_ABI, provider);

      if (recovery.launch) {
        const receipt = await settleRaw(provider, recovery.launch, this.config.confirmations, wallet.address);
        await verifyLaunched(factoryRead, recovery.launch.predictedTokenAddress, wallet.address);
        return resultFor(metadata, wallet.address, recovery.launch.predictedTokenAddress, recovery.launch.hash, receipt);
      }

      const [launchFee, launchEnabled, feeData, funderBalance] = await Promise.all([
        factoryRead.launchFee() as Promise<bigint>,
        factoryRead.launchEnabled() as Promise<boolean>,
        provider.getFeeData(),
        provider.getBalance(funder.address)
      ]);
      if (!launchEnabled) throw new LaunchBudgetError("PONS launches are currently disabled on-chain.");
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
      if (!gasPrice) throw new LaunchBudgetError("RPC did not return a usable gas price.");
      const salt = recovery.salt ?? hexlify(randomBytes(32));
      const params = launchParams(metadata, imageUri, wallet.address);

      const estimator: any = factoryRead.connect(funder);
      const estimated = await estimator.launchToken.estimateGas(
        params,
        this.config.launchConfigId,
        this.config.dexId,
        salt,
        { value: launchFee }
      ) as bigint;
      const bufferedEstimate = bufferGas(estimated);
      if (launchFee + bufferedEstimate * gasPrice > this.config.fundingWei) {
        throw new LaunchBudgetError(
          `Current PONS fee plus buffered gas exceeds the ${formatFunding(this.config.fundingWei)} ETH launch-wallet cap.`
        );
      }

      if (recovery.funding) {
        await settleRaw(provider, recovery.funding, this.config.confirmations, funder.address);
        await hooks.funded();
      } else if (!recovery.fundingConfirmed) {
        const fundingGas = 21_000n * gasPrice;
        if (funderBalance < this.config.fundingWei + fundingGas + this.config.funderMinimumRemainingWei) {
          throw new LaunchBudgetError("The launch funder cannot pay 0.001 ETH while preserving its protected gas reserve.");
        }
        let preparedFunding!: PreparedLaunchTransaction;
        await withNonceLock(funder.address, async () => {
          preparedFunding = await signPrepared(funder, provider, {
            to: wallet.address,
            value: this.config.fundingWei,
            gasLimit: 21_000n,
            gasPrice
          });
          await hooks.fundingPrepared(preparedFunding);
          await broadcastRaw(provider, preparedFunding);
        });
        await waitRaw(provider, preparedFunding, this.config.confirmations);
        await hooks.funded();
      }

      const signer = wallet.connect(provider);
      const factory: any = factoryRead.connect(signer);
      const exactEstimate = await factory.launchToken.estimateGas(
        params,
        this.config.launchConfigId,
        this.config.dexId,
        salt,
        { value: launchFee, gasPrice }
      ) as bigint;
      const exactGasLimit = bufferGas(exactEstimate);
      const walletBalance = await provider.getBalance(wallet.address);
      if (launchFee + exactGasLimit * gasPrice > walletBalance) {
        throw new LaunchBudgetError("Exact launch gas rose above the isolated wallet balance after funding.");
      }
      const predicted = getAddress(await factory.launchToken.staticCall(
        params,
        this.config.launchConfigId,
        this.config.dexId,
        salt,
        { value: launchFee, gasLimit: exactGasLimit, gasPrice }
      ) as string);
      const populated = await factory.launchToken.populateTransaction(
        params,
        this.config.launchConfigId,
        this.config.dexId,
        salt,
        { value: launchFee }
      );
      let preparedLaunch!: PreparedLaunchTransaction & { predictedTokenAddress: string };
      await withNonceLock(wallet.address, async () => {
        preparedLaunch = {
          ...await signPrepared(signer, provider, {
            ...populated,
            gasLimit: exactGasLimit,
            gasPrice
          }),
          predictedTokenAddress: predicted
        };
        await hooks.launchPrepared(preparedLaunch);
        await broadcastRaw(provider, preparedLaunch);
      });
      const receipt = await waitRaw(provider, preparedLaunch, this.config.confirmations);
      await verifyLaunched(factoryRead, predicted, wallet.address);
      return resultFor(metadata, wallet.address, predicted, preparedLaunch.hash, receipt);
    } finally {
      provider.destroy();
    }
  }
}

async function signPrepared(
  signer: BaseWallet,
  provider: JsonRpcProvider,
  request: TransactionRequest
): Promise<PreparedLaunchTransaction> {
  const [network, nonce] = await Promise.all([
    provider.getNetwork(),
    provider.getTransactionCount(signer.address, "pending")
  ]);
  const rawTx = await signer.signTransaction({ ...request, chainId: network.chainId, nonce });
  return { hash: keccak256(rawTx), rawTx, nonce };
}

async function settleRaw(
  provider: JsonRpcProvider,
  transaction: PreparedLaunchTransaction,
  confirmations: number,
  signerAddress: string
): Promise<TransactionReceipt> {
  const known = await provider.getTransactionReceipt(transaction.hash);
  if (known) {
    if (known.status !== 1) throw new Error("Prepared launch transaction reverted.");
    return known;
  }
  await withNonceLock(signerAddress, () => broadcastRaw(provider, transaction));
  return waitRaw(provider, transaction, confirmations);
}

async function broadcastRaw(
  provider: JsonRpcProvider,
  transaction: PreparedLaunchTransaction
): Promise<void> {
  try {
    const response = await provider.broadcastTransaction(transaction.rawTx);
    if (response.hash !== transaction.hash) throw new Error("Prepared transaction hash mismatch.");
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes("already known") && !message.includes("known transaction") && !message.includes("nonce has already been used")) {
      throw error;
    }
  }
}

async function waitRaw(
  provider: JsonRpcProvider,
  transaction: PreparedLaunchTransaction,
  confirmations: number
): Promise<TransactionReceipt> {
  const receipt = await provider.waitForTransaction(transaction.hash, confirmations, 180_000);
  if (!receipt || receipt.status !== 1) throw new Error("Prepared launch transaction failed or timed out.");
  return receipt;
}

async function verifyLaunched(factory: any, token: string, wallet: string): Promise<void> {
  const launched = await factory.getLaunchedToken(token);
  if (!launched.exists) throw new Error("PONS factory did not register the predicted token.");
  if (getAddress(launched.deployer) !== getAddress(wallet)) throw new Error("PONS deployer verification failed.");
  if (getAddress(launched.pairedToken) !== getAddress(WETH)) throw new Error("PONS paired-token verification failed.");
}

function resultFor(
  metadata: LaunchMetadata,
  wallet: string,
  token: string,
  hash: string,
  receipt: TransactionReceipt
): LaunchResult {
  return {
    tokenAddress: getAddress(token),
    walletAddress: getAddress(wallet),
    launchTxHash: hash,
    launchBlock: receipt.blockNumber,
    metadata
  };
}

function launchParams(metadata: LaunchMetadata, logo: string, feeWallet: string) {
  return {
    name: metadata.name,
    symbol: metadata.symbol,
    logo,
    description: metadata.description,
    socials: {
      twitter: metadata.twitter ?? "",
      telegram: metadata.telegram ?? "",
      discord: metadata.discord ?? "",
      website: metadata.website ?? "",
      farcaster: metadata.farcaster ?? ""
    },
    feeWallet
  };
}

function bufferGas(value: bigint): bigint {
  return (value * 120n + 99n) / 100n;
}

function formatFunding(value: bigint): string {
  return Number(value) / Number(parseEther("1")) === 0.001 ? "0.001" : value.toString();
}
