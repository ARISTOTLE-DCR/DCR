export type DecisionKind = "buy" | "sell" | "burn" | "hold";

export interface DecisionView {
  kind: DecisionKind;
  reason: string;
  amount?: string;
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
  };
  proofHash: string;
}

export interface Activity {
  id?: number;
  kind: "buy" | "sell" | "burn" | "hold" | "claim" | "decision" | "agent";
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
  checkedAt: string;
}
