This project was edited by [Aristotle](https://aristotle.harmonic.fun).

To cite Aristotle:
- Tag @Aristotle-Harmonic on GitHub PRs/issues
- Add as co-author to commits:
```
Co-authored-by: Aristotle (Harmonic) <aristotle-harmonic@harmonic.fun>
```

# PONS Discrete Curvature Reservoir v2

A complete dry-run-first Robinhood Chain creator-fee controller. See `STRATEGY.md` for the derivation, sell-cone proof interpretation, permanent-liquidity consequences, and holder-selection analysis.

## Install and verify

```sh
npm ci
npm run typecheck
npm test
npm run build
lake build RequestProject.Main
cp .env.example .env
npm run inspect
```

Node 20+ is required. `TOKEN_ADDRESS` is mandatory. Signing requires both `SIGNING_ENABLED=true` and a `CREATOR_PRIVATE_KEY` whose address is the resolved fee recipient; the public fixture is always blocked from signing. Native ETH is used only for gas.

`DATA_ROOT/<lowercase-token>/` contains atomic v2 state, the cycle journal, holder cursor and recoverable airdrop plan. Set the verified token deployment block in `TOKEN_LAUNCH_BLOCK`; ordinary BUY/SELL/BURN/LP decisions start immediately from bounded recent pool observations, while airdrops remain unavailable until indexing reaches the finalized snapshot.

## Migration

The runtime automatically migrates a v1 `state.json` found in the token directory while preserving `lastSqrtPriceX96`, block, timestamp, reserves, integral and last-action time. For an explicit offline migration:

```sh
node migrate-v1.mjs old-state.json data/<token-without-0x>/state.json 0xToken
```

Stop the service before migration and retain the old file as backup. The persisted `nextRunAt` is honored after restarts.

## Operations

Install `dcr-agent.service` under systemd after adjusting `User`, `WorkingDirectory`, and protected environment placement. Dry-run is the default. The service has filesystem hardening and writes only the project data directories. Never put a key in source control.

Actions are journaled before execution. Confirmed hashes and airdrop recipient status prevent duplicate economic actions. An uncertain in-flight non-airdrop transaction causes fail-closed overlap refusal pending receipt reconciliation; airdrops automatically resume unpaid recipients. LP always creates a new canonical-pool NFT and permanently transfers it to the burn address; the original PONS launch position is never touched.

This software is experimental and makes no performance or profit claim.
