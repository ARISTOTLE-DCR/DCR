# DCR

ca - 0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a 

Discrete Curvature Reservoir is an experimental creator-fee controller and
public transparency dashboard for a token launched through PONS on Robinhood
Chain.

The repository contains:

- the original, unmodified Aristotle-generated TypeScript controller;
- the machine-checked Lean model supplied with that controller;
- a read-only observer and HTTP/SSE API;
- a responsive public dashboard with live chain state, agent events, proofs,
  formulas, and explorer links;
- fork-based transaction-path tests;
- the immutable Aristotle result archive exposed by the dashboard.

> This is experimental financial software. Read
> [Operational safety](#operational-safety) before enabling signing.

## Strategy

DCR treats the fee-recipient wallet's WETH and launched-token balances as two
reservoirs. It observes local price displacement, recent WETH swap flow, and
pool liquidity. It then chooses a countercyclical `BUY`, `SELL`, or `HOLD`.

Let:

- `s_n` be the current V3 `sqrtPriceX96`;
- `L_n` be current pool liquidity;
- `V_n` be observed absolute WETH swap flow;
- `R^W_n` and `R^T_n` be the wallet's WETH and token balances.

The signed displacement is:

```text
r_n = 10^6 (s_n² - s_(n-1)²) / s_(n-1)²
```

The flow pressure and adaptive dead zone are:

```text
q_n = 10^6 V_n / (L_n + 1)
d_n = 1500 + min(q_n, 25000) / 5
```

Excess curvature, cubic response energy, and spend fraction are:

```text
e_n = max(|r_n| - d_n, 0)
C_n = e_n³ / (d_n² + 1)
f_n = clamp(C_n / 200, 25, 1250) / 10000
```

The action follows directly:

- `|r_n| <= d_n`: hold;
- `r_n < -d_n`: spend `f_n R^W_n` WETH to buy the token;
- `r_n > d_n`: sell `f_n R^T_n` tokens into WETH.

When a trade signal exists, `f_n` is between `0.25%` and `12.5%`. The cap is
per cycle and applies to the remaining balance of the asset being spent.

The controller runs again after a randomized 10–15 minute sleep. The effective
start-to-start interval is the cycle duration plus that sleep.

## Architecture

```text
Robinhood Chain
      │
      ├── original Aristotle agent ── signs claims/swaps
      │             │
      │             └── external log capture
      │
      └── read-only observer ── HTTP + SSE ── public dashboard
```

Trust boundaries:

- `aristotle-output/input_aristotle/` is the signing controller.
- `observer/` is read-only and must never receive the private key.
- `dashboard/` talks only to the observer API.
- On-chain receipts and emitted events are authoritative for claims and swaps.
- `aristotle-result.tar.gz` is the fixed source archive offered by the
  dashboard's verification link.

The external agent runner records the original controller's events and adds a
20% gas-limit buffer to RPC estimates; unused gas is not charged. If the router
rejects a swap because its quote became stale or its first transaction reverted,
the runner performs one immediate retry of the same Aristotle decision with a
fresh quote. The retry does not change the action, amount, mathematical policy,
or 0.75% slippage limit, and its result is written to the same public execution
log.

## Repository layout

```text
aristotle-output/input_aristotle/  Original Aristotle controller and Lean proof
dashboard/                         React/Vite public dashboard
observer/                          Read-only observer, API, SSE and log capture
fork-tests/                        Robinhood Chain fork execution checks
input/                             Original prompt and neutral PONS reference
aristotle-result.tar.gz            Immutable Aristotle result archive
```

## Requirements

- Node.js `22.5+`
- npm
- Lean toolchain from `lean-toolchain` only if rebuilding the formal proof
- Access to a Robinhood Chain RPC endpoint

## Install and build

Build the unchanged agent:

```sh
cd aristotle-output/input_aristotle
npm ci
npm run typecheck
npm test
npm run build
```

Build the dashboard:

```sh
cd dashboard
npm ci
npm run typecheck
npm run build
```

Build the observer:

```sh
cd observer
npm ci
npm run typecheck
npm run build
```

## Configuration

There are three separate environment files. Never commit any of them.

### 1. Signing agent

Create `aristotle-output/input_aristotle/.env` from its `.env.example`:

```env
TOKEN_ADDRESS=0x_your_launched_token
CREATOR_PRIVATE_KEY=your_fee_recipient_private_key
RPC_URL=https://rpc.mainnet.chain.robinhood.com
SIGNING_ENABLED=false
STATE_FILE=./data/dcr-production.json
```

Use a fresh, token-specific `STATE_FILE`. Do not reuse a state file created for
another token: the previous `sqrtPriceX96` baseline would be invalid.

Keep `SIGNING_ENABLED=false` for the first inspection. The signer must exactly
match the PONS-resolved fee recipient or execution is refused.

### 2. Read-only observer

Create `observer/.env` from its `.env.example`:

```env
TOKEN_ADDRESS=0x_your_launched_token
RPC_URL=https://rpc.mainnet.chain.robinhood.com
OBSERVER_PORT=4174
OBSERVER_HOST=127.0.0.1
OBSERVER_POLL_MS=15000
AGENT_ROOT=../aristotle-output/input_aristotle
AGENT_STATE_FILE=../aristotle-output/input_aristotle/data/dcr-production.json
ARISTOTLE_ARCHIVE=../aristotle-result.tar.gz
OBSERVER_DATA_DIR=./data
```

The observer must use the same token and state path as the agent. Never put
`CREATOR_PRIVATE_KEY` in this file.

### 3. Dashboard

Create `dashboard/.env` from its `.env.example` before building:

```env
VITE_TWITTER_URL=https://x.com/discreteonrh
VITE_TOKEN_TICKER=DCR
```

Vite embeds these values at build time, so rebuild the dashboard after changing
them.

## First dry run

With `SIGNING_ENABLED=false`:

```sh
cd aristotle-output/input_aristotle
npm run inspect
```

Confirm:

- chain ID is `4663`;
- token, canonical pool, paired WETH, deployer, and fee recipient are correct;
- the first observation holds and establishes a new baseline;
- wallet balances and claim simulation are plausible;
- no transaction is sent.

Only after verifying the inspection should an operator deliberately change
`SIGNING_ENABLED=true`.

## Run

Terminal or service 1 — observer, API, SSE, and built website:

```sh
cd observer
npm start
```

Terminal or service 2 — original agent with external log capture:

```sh
cd observer
npm run agent
```

Open `http://127.0.0.1:4174`.

Running the agent directly from its own directory still performs the strategy,
but the dashboard will not receive exact off-chain hold decisions or scheduler
events.

## Server deployment

1. Build all three packages as shown above.
2. Keep the agent and observer as two separately supervised long-running
   processes.
3. Keep `OBSERVER_HOST=127.0.0.1`.
4. Put a TLS reverse proxy such as Caddy or Nginx in front of port `4174`.
5. Expose only the observer HTTP port.
6. Never serve the agent directory, `.env` files, runtime `data/`, or private
   key as static content.
7. Back up the agent state and transaction-monitoring records before upgrades.

The production server installation exposes a root-only activation command:

```sh
activate <PONS_TOKEN_ADDRESS>
```

It validates chain `4663`, the PONS launch record, canonical pool, paired WETH,
and the resolved creator-fee recipient before changing the active token.
Signing is enabled only when the protected server key is exactly that
fee-recipient wallet. The command then assigns token-specific state/history
paths, starts the agent, waits for its first state, starts the observer, and
verifies that the public API is serving the requested token.

For a read-only preview of any valid PONS token:

```sh
activate --dry-run <PONS_TOKEN_ADDRESS>
```

The preview form never places the private key in the agent environment and
forces `SIGNING_ENABLED=false`.

The observer serves the compiled dashboard automatically when
`dashboard/dist/` exists.

## Dashboard behavior

The public site provides:

- the latest Robinhood Chain head;
- token price, market cap, observed WETH flow, and reserve balances;
- claim simulation status;
- current DCR decision;
- live observer and agent events over SSE;
- data-refresh progress and the real next-cycle countdown;
- Blockscout links;
- a detailed strategy explainer with formulas;
- archive and source SHA-256 verification.

`OBSERVED FLOW` is absolute WETH swap flow in the bounded observation window,
not a 24-hour or net directional volume.

`CREATOR FEE STATUS` is a read-only claim simulation:

- `CLAIMABLE`: fees can currently be claimed;
- `EMPTY`: the locker reports no fees to collect;
- `UNAVAILABLE`: the simulation or RPC request failed.

## Operational safety

The transaction paths for claim, buy, sell, and burn were exercised on an
Anvil fork of the real Robinhood Chain deployment. Both complete policy
directions were verified:

```text
pool movement -> observation -> DCR decision -> quote -> approval ->
router transaction -> receipt -> balance reconciliation
```

Important limitations remain:

1. **Use a dedicated fee wallet.** The policy reads the wallet's entire WETH and
   launched-token balances. It cannot distinguish claimed fees from unrelated
   assets manually sent to the same address.
2. **The 12.5% cap is per cycle.** Repeated same-direction signals can convert
   most of one reservoir over time.
3. **Native ETH is gas only.** The strategy trades WETH, not native ETH, but it
   does not enforce a minimum ETH gas reserve.
4. **Pending transactions are not durably recovered after a process crash.**
   If the process stops after submission but before receipt handling completes,
   the next process has no persisted transaction intent, hash, or nonce. This
   is the primary blocker for unattended control of significant funds.
5. **Empty claims are misclassified in the original agent.** PONS currently
   uses `NoFeesToCollect()` selector `0x6a4ea9e4`, while the unmodified agent
   checks a different selector. The scheduler continues and trading is not
   blocked, but its claim log can show `failed` instead of `empty`.
6. **Claim receipts are not balance-reconciled by the original agent.** The
   fork audit independently confirmed correct claim deltas, but the live agent
   only checks receipt success for claims.

Use dry-run or closely supervised, limited-value operation unless these risks
are accepted and separately mitigated.

## Verification

Agent:

```sh
cd aristotle-output/input_aristotle
npm run typecheck
npm test
npm run build
```

Dashboard and observer:

```sh
cd dashboard
npm run typecheck
npm run build

cd ../observer
npm run typecheck
npm run build
```

Lean:

```sh
cd aristotle-output/input_aristotle
lake build
```

The supplied deterministic tests, TypeScript builds, Lean proof, read-only
chain inspection, and external fork transaction scenarios have passed.

## Provenance

- Aristotle project: `5999f818-6116-43e6-8a4e-af4e0b5c35c8`
- Aristotle task: `cf26e10a-a7d1-41be-a1db-9c3eed226b85`
- Archive SHA-256:
  `a970ea9f9cf477e9380ca17b8f218d770e5f9866a807815ce4fb7799ced6974c`
- Immutable source SHA-256:
  `21c9137399f51c1205a269b5e24b48a67b89eb0bb2745d792d70b362ffc685d2`

The observer recalculates both hashes at startup. The dashboard reports whether
the extracted Aristotle source still matches the archived result.

## License

No license has been granted. The repository is private unless the owner
explicitly changes its visibility.
