export type LaunchMetadata = {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
};

export type LaunchStage =
  | "reserved"
  | "wallet_created"
  | "funding_prepared"
  | "funding_submitted"
  | "funded"
  | "launch_prepared"
  | "launch_submitted"
  | "launched"
  | "failed_before_funding"
  | "failed_after_funding";

export type LaunchRecord = {
  id: string;
  requestTweetId: string;
  authorId: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
  stage: LaunchStage;
  metadata: LaunchMetadata;
  imageUri?: string;
  walletAddress?: string;
  keystoreFile?: string;
  fundingWei: string;
  fundingTxHash?: string;
  fundingRawTx?: string;
  fundingNonce?: number;
  launchSalt?: string;
  launchTxHash?: string;
  launchRawTx?: string;
  launchNonce?: number;
  predictedTokenAddress?: string;
  tokenAddress?: string;
  launchBlock?: number;
  error?: string;
};

export type LaunchRegistryData = {
  version: 1;
  records: LaunchRecord[];
};

export type LaunchResult = {
  tokenAddress: string;
  walletAddress: string;
  launchTxHash: string;
  launchBlock: number;
  metadata: LaunchMetadata;
};
