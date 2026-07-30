export type DecisionKind =
  | "buy"
  | "sell"
  | "burn"
  | "permanent_lp"
  | "weth_airdrop"
  | "hold";

export interface DecisionView {
  kind: DecisionKind;
  reason: string;
  amount?: string;
  amountToken?: string;
  amountWeth?: string;
  total?: string;
  recipientCount?: number;
  snapshotBlock?: number;
  tickLower?: number;
  tickUpper?: number;
  score?: string;
  quoteOut?: string;
}

export interface Snapshot {
  id?: number;
  capturedAt: string;
  block: number;
  blockTimestamp: number;
  chainId: number;
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
  };
  pool: {
    address: string;
    sqrtPriceX96: string;
    liquidity: string;
    priceWeth: string;
    marketCapWeth: string;
    volumeWeth: string;
    swapCount: number;
  };
  treasury: {
    address: string;
    wethBalance: string;
    tokenBalance: string;
    nativeEthBalance: string;
  };
  claim: {
    status: "claimable" | "empty" | "unavailable";
    weth?: string;
    token?: string;
    detail?: string;
  };
  decision: DecisionView;
  agent: {
    online: boolean;
    stateBlock: number;
    stateTimestamp: number;
    lastActionAt: number;
    nextRunAt: number;
    cycleSeq: number;
    activeCycleId?: string | undefined;
  };
  operations: {
    holderIndex: {
      cursor: number;
      target: number;
      trackedAddresses: number;
      complete: boolean;
    };
    cycle: {
      id?: string | undefined;
      stage: "none" | "planned" | "executing" | "confirmed" | "failed";
      updatedAt?: number | undefined;
    };
    lp: {
      cycleId?: string | undefined;
      stage:
        | "none"
        | "planned"
        | "mint_prepared"
        | "minted"
        | "lock_prepared"
        | "locked"
        | "failed";
      tokenId?: string | undefined;
    };
    airdrop: {
      cycleId?: string | undefined;
      stage: "none" | "committed" | "paying" | "confirmed" | "failed";
      totalWeth?: string | undefined;
      recipientCount: number;
      confirmedCount: number;
    };
  };
  proofHash: string;
}

export interface Activity {
  id?: number;
  kind:
    | "buy"
    | "sell"
    | "burn"
    | "permanent_lp"
    | "weth_airdrop"
    | "hold"
    | "claim"
    | "decision"
    | "agent";
  status: "observed" | "confirmed" | "failed" | "skipped";
  timestamp: string;
  block?: number;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  assetIn?: string;
  assetOut?: string;
  reason?: string;
  payload?: unknown;
}

export interface Provenance {
  projectId: string;
  taskId: string;
  archiveSha256: string;
  sourceSha256: string;
  sourceUnmodified: boolean;
  archiveVerified: boolean;
  productionHardened: boolean;
  checkedAt: string;
}
