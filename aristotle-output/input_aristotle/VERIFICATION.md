# Verification report

Run on 2026-07-30 from the project root.

| Command | Result |
|---|---|
| `npm ci` | Passed; 16 packages installed, 0 vulnerabilities reported. |
| `npm run typecheck` | Passed with strict TypeScript settings. |
| `npm test` | Passed: 21/21 deterministic tests. These cover every policy action, rare-sell gating, orientation, reserve caps, tick alignment, 1- and 10-recipient deterministic sampling, uniqueness/conservation, dry-run safety, v1 migration, schedule persistence, and cycle-journal idempotency. |
| `npm run build` | Passed. |
| `lake build RequestProject.Main` | Passed. |
| source scan `rg -n 'sorry\|admit' RequestProject/Main.lean` | No matches. |
| theorem axiom check for `CurvatureReservoir.sell_cone_strict` | Only `propext`, `Classical.choice`, and `Quot.sound`. |
| `TOKEN_ADDRESS=0x29b9e5306cbc8e0e8e4c1d63fc85a843303e0c7a SIGNING_ENABLED=false DATA_ROOT=/tmp/dcr-v2-inspect npm run inspect` | Passed against the public Robinhood Chain RPC at block 23670288. Verified chain/launch/position-manager/canonical pool; observed pool tick, spacing, liquidity, balances and claim simulation; selected initial HOLD. No transaction was broadcast. |

The environment did not provide a local Anvil executable, so the supplied fork scripts were retained as transaction-path references but were not represented as executed here. Mainnet was kept strictly read-only.
