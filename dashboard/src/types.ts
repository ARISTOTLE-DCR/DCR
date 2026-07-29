export interface Decision {
  kind: "buy" | "sell" | "burn" | "hold";
  reason: string;
  amount?: string;
  score?: string;
  quoteOut?: string;
}

export interface Snapshot {
  capturedAt: string;
  block: number;
  blockTimestamp: number;
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
  decision: Decision;
  agent: {
    online: boolean;
    stateBlock: number;
    stateTimestamp: number;
    lastActionAt: number;
  };
  proofHash: string;
}

export interface Provenance {
  projectId: string;
  taskId: string;
  archiveSha256: string;
  sourceSha256: string;
  sourceUnmodified: boolean;
  checkedAt: string;
}

export interface Activity {
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
}

export interface AgentEvent {
  timestamp: string;
  eventType: string;
  payload: unknown;
}

export interface StatusResponse {
  snapshot: Snapshot | null;
  provenance: Provenance | null;
  pollIntervalMs: number;
}
