# Verified holder-index and WETH-airdrop tool surface

These are neutral on-chain primitives and safety requirements. They do not
prescribe when to airdrop, how much to allocate below the 12.5% cap, the
eligibility threshold, sampling weights, or the payout distribution.

## Canonical data

- DCR token: `0x29b9e5306CBC8e0E8e4C1d63FC85A843303E0c7A`
- DCR launch block: `23534520`
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- DCR canonical pool: `0x1D78718706Eee71e374194250c66c58Aa30Da0A2`
- Fee recipient/reserve:
  `0xFe884239Ab22cA90BB86a33120aD932bd52339F1`
- ERC-20 Transfer topic:
  `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`

The DCR addresses above are production read-only fixtures for validation. The
implementation must discover token, launch block, pool, and reserve from
runtime configuration and verified PONS metadata so it works for another PONS
token without source edits.

## Required ERC-20 interface

```solidity
function balanceOf(address account) view returns (uint256);
function transfer(address recipient, uint256 amount) returns (bool);

event Transfer(
  address indexed from,
  address indexed to,
  uint256 value
);
```

## Bounded holder indexing reference

This illustrates the callable surface and exact balance-delta accounting. It is
not a complete indexer and does not prescribe the eligibility model.

```ts
import { Interface, JsonRpcProvider, getAddress } from "ethers";

const erc20 = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
const transferTopic = erc20.getEvent("Transfer")!.topicHash;

export async function transferLogs(
  provider: JsonRpcProvider,
  token: string,
  fromBlock: number,
  toBlock: number
) {
  // The caller must keep the range bounded, retry smaller chunks on provider
  // limits, persist the last finalized cursor, and handle reorg rollback.
  return provider.getLogs({
    address: getAddress(token),
    fromBlock,
    toBlock,
    topics: [transferTopic]
  });
}
```

Reconstruct balances by subtracting each decoded transfer from `from` unless it
is the zero address and adding it to `to` unless it is the zero address. Treat a
negative reconstructed balance, duplicate log identity, or cursor gap as an
index-integrity failure. Before a holder can enter an airdrop snapshot, reconcile
its indexed balance with `balanceOf` at the same finalized block.

## Auditable future-block randomness reference

Financial recipient selection must not use JavaScript randomness. A minimal
auditable construction fixes a future block number before its hash is known:

```ts
import {
  JsonRpcProvider,
  solidityPackedKeccak256
} from "ethers";

export interface RandomnessCommitment {
  cycleId: string;
  token: string;
  snapshotBlock: number;
  anchorBlock: number;       // chosen and persisted while still in the future
  eligibleSetHash: string;   // canonical sorted (address,balance) commitment
}

export async function deriveSeed(
  provider: JsonRpcProvider,
  commitment: RandomnessCommitment
): Promise<string> {
  const anchor = await provider.getBlock(commitment.anchorBlock);
  if (!anchor?.hash) throw new Error("randomness anchor is not finalized");
  return solidityPackedKeccak256(
    ["bytes32", "address", "uint256", "uint256", "bytes32", "bytes32"],
    [
      commitment.cycleId,
      commitment.token,
      commitment.snapshotBlock,
      commitment.anchorBlock,
      commitment.eligibleSetHash,
      anchor.hash
    ]
  );
}
```

Persist and publicly log the commitment before the anchor block is mined.
Require a confirmation/finality margin before using the block hash. Sampling
must be deterministic, without replacement, and avoid modulo bias. The complete
recipient list and exact amounts must be persisted before the first WETH
transfer.

## Recoverable payout plan

At minimum, persist:

```ts
interface AirdropPlan {
  version: 1;
  cycleId: string;
  snapshotBlock: number;
  anchorBlock: number;
  eligibleSetHash: string;
  seed?: string;
  totalWeth: string;
  recipients: Array<{
    address: string;
    amount: string;
    status: "pending" | "submitted" | "confirmed" | "failed";
    txHash?: string;
    receiptBlock?: number;
  }>;
}
```

Before advancing a submitted item, reconcile its nonce/receipt and both sender
and recipient WETH balance deltas. A restart must never regenerate recipients
for an existing cycle and must never resend a confirmed item.
