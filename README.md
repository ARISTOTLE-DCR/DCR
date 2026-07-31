# Discrete Curvature Reservoir

DCR is an autonomous creator-fee controller for a PONS token on Robinhood
Chain (chain ID `4663`). Aristotle generated the v2 mathematical strategy and
complete TypeScript implementation. The production copy adds narrowly scoped
execution/restart hardening, while `aristotle-result.tar.gz` preserves the
original Aristotle result byte-for-byte.

The public observer and dashboard expose balances, decisions, receipts,
holder-index progress, LP-lock state, airdrop state, timers, source hashes and
the mathematical specification without access to the signing key.

The optional public-launch fleet extends the same policy to tokens created by
the X agent. Each launch receives a generated encrypted creator wallet, its own
PONS fee stream, state directory, 10–15 minute timer, holder index and public
page at `/token/<CA>`. No reserve or private key is shared between tokens.

## Strategy

For V3 `sqrtPriceX96 = s`, DCR computes the oriented displacement

```text
r = ±10⁶(s² − s_prev²) / s_prev²
```

and flow pressure / adaptive dead zone

```text
q = 10⁶ · recentWethFlow / (liquidity + 1)
d = 1500 + min(q, 25000) / 5
```

Swap size is derived from excess curvature:

```text
e = max(|r| − d, 0)
C = e³ / (d² + 1)
f = clamp(C / 200, 25, 1250) / 10000
```

The deterministic policy is:

- `BUY` when `r < -d`, spending `0.25%–12.5%` of WETH.
- `SELL` only when `r > 4d` **and** token inventory value is more than twice
  WETH, selling `0.25%–12.5%` of token inventory.
- In calm conditions (`|r| ≤ d`):
  - burn `6.25%` of tokens when token value is over twice WETH;
  - allocate up to `10%` of each asset to a new V3 position when inventories
    are balanced and flow is material, then transfer its NFT to `0x…dEaD`;
  - distribute `6.25%` of WETH to 1–10 finalized indexed holders when WETH is
    over twice token value.
- Otherwise `HOLD`.

Every cycle claims available creator fees first, then chooses one action. The
next cycle time is randomly selected between 10 and 15 minutes and persisted
before the economic action, so a restart does not reset the timer.

## Safety model

- Dry-run is the default.
- Live signing requires the key-derived address to exactly match the PONS fee
  recipient.
- Native ETH is gas only; strategy capital is WETH plus the launched token.
- If native ETH falls below the gas floor, the agent may unwrap only its own
  WETH up to the configured gas target; the funding wallet is not reused.
- Swaps use fresh quotes, 0.75% minimum-output tolerance, simulation, a 20% gas
  estimate buffer, exact approvals, receipt/balance reconciliation and at most
  one fresh-quote retry.
- Prepared transaction hash/raw bytes are persisted before broadcast.
- Restarts recover the exact prepared transaction and refuse overlapping
  cycles.
- LP positions are verified against the canonical pair, pool fee, range,
  liquidity and owner before permanent locking; the original launch position
  is rejected.
- Holder selection commits the finalized eligible set before future-block
  randomness is available. Payouts are unique, persisted and reconciled
  individually.

## Repository layout

```text
aristotle-output/input_aristotle/  production agent source
aristotle-result.tar.gz            original Aristotle v2 result
fork-tests/                        Robinhood fork integration tests
observer/                          read-only API, SSE and agent log capture
dashboard/                         public React dashboard
observer/src/fleet.ts              isolated multi-token worker supervisor
x-agent/                           X replies, /scan and crash-safe /launch
deploy/                            systemd, Nginx and activation scripts
```

## Local verification

Requires Node.js 22+.

```bash
cd aristotle-output/input_aristotle
npm ci
npm run typecheck
npm test
npm run build

cd ../../observer
npm ci
npm run typecheck
npm run build

cd ../dashboard
npm ci
npm run typecheck
npm run build
```

Fork integration tests require a local Anvil fork on port `18547` and use no
mainnet signing:

```bash
node fork-tests/fork-positive.mjs
node fork-tests/fork-policy-e2e.mjs
node fork-tests/fork-policy-rise-e2e.mjs
node fork-tests/fork-v2-lp-airdrop.mjs
```

## Configuration

Agent:

```dotenv
TOKEN_ADDRESS=0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a
RPC_URL=https://your-robinhood-rpc
SIGNING_ENABLED=false
DATA_ROOT=./data
TOKEN_LAUNCH_BLOCK=23534520
# CREATOR_PRIVATE_KEY=never-commit-this
```

Observer never receives the private key. See `observer/.env.example`.

Public fleet signing is independently gated by `FLEET_ENABLED` and
`FLEET_SIGNING_ENABLED`. Generated wallets are stored as encrypted JSON
keystores under `/var/lib/dcr-launcher`; the registry never contains a raw
private key. The X launcher and all strategy processes share an address-scoped
nonce lock so a funding transfer cannot collide with a DCR cycle.

## Server activation

The installed command validates the canonical PONS pool, resolves the exact
deployment block and confirms fee-recipient ownership before enabling signing:

```bash
activate 0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a
```

Read-only mode:

```bash
activate --dry-run 0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a
```

## Provenance

- Aristotle project: `450de4b7-0ce3-461d-bf4e-ff07458ae998`
- Aristotle task: `a465e2f3-38d2-4387-897a-b1a45006b302`
- Original archive SHA-256:
  `0327594738a72fe1a97ffac6dbb012196097d8d8962c4677dd33738e265fc6c0`

Production hardening is intentionally reported separately from the immutable
archive instead of claiming that the runtime source is byte-identical.
