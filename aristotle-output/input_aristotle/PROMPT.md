# Extend your Discrete Curvature Reservoir into a buy-biased permanent-liquidity controller

Complete this as one continuous Aristotle project. The supplied source tree is
your own previous Discrete Curvature Reservoir (DCR) project. Preserve DCR's
mathematical identity and use its discrete-curvature/reservoir framework as the
base. Do not discard it and replace it with an unrelated strategy.

The user now wants you to derive a principled extension of that model and
implement the extension as a complete production-ready agent.

## Required qualitative behavior

The revised controller must be structurally biased toward supporting the token
with creator-fee capital:

- BUY decisions must arise substantially more readily than SELL decisions.
- SELL must be exceptional. Positive price curvature alone must no longer be
  sufficient to sell. Even during a rising market, selling should usually not
  occur.
- Do not implement this with randomness, an arbitrary fixed probability, a
  hardcoded "buy more often" counter, or a cosmetic multiplier. Derive a
  mathematically coherent asymmetry, invariant, hysteresis, constrained
  optimization, one-sided potential, solvency condition, or other elegant
  extension of DCR.
- Derive the sell-admissible region so that it is a strict, meaningfully
  narrower subset of state space than the buy-admissible region. Explain and,
  where appropriate, formally prove the property.
- Preserve the existing per-cycle safety philosophy: no action may spend more
  than 12.5% of the corresponding currently reconciled creator-fee reserve.
  Your theory may choose a stricter bound.

The policy must also include reachable, mathematically justified BURN,
PERMANENT_LP, and WETH_AIRDROP actions. They must not be decorative enum
members or unreachable branches. Deterministic tests must exercise realistic
states that select every action, including the rare SELL.

You decide the formulas, state variables, allocation logic, thresholds, tick
range, reserve floors, and relationships among BUY, BURN, PERMANENT_LP,
WETH_AIRDROP, rare SELL, and HOLD. The requested behavior is a design
constraint, not a supplied mathematical model. Mathematics must come first and
the mechanics must follow from it.

## Permanent LP semantics

Read `LP_TOOLS.md` and implement the full code path yourself.

A PERMANENT_LP action must:

1. use only reconciled creator-fee DCR and WETH held by the resolved fee
   recipient;
2. mint a new Uniswap V3 NFT position in the already-existing canonical
   DCR/WETH pool through the verified deployed NonfungiblePositionManager;
3. derive and validate a mathematically meaningful tick range aligned to the
   pool's live tick spacing;
4. protect both token amounts with bounded minimums, a short deadline,
   simulations, temporary exact approvals, receipts, and post-transaction
   balance/liquidity reconciliation;
5. identify the actual minted tokenId from the confirmed result/events and
   verify its token pair, fee tier, tick range, nonzero liquidity, and initial
   ownership;
6. irreversibly transfer that position NFT with `transferFrom` to
   `0x000000000000000000000000000000000000dEaD`;
7. confirm `ownerOf(tokenId)` is the burn address and clear any residual token
   allowances.

This is an intentional permanent lock, not an ERC-721 supply burn. Once
transferred, the position cannot be increased, decreased, collected, or
rebalanced, and its future LP fees are inaccessible. Therefore every later LP
action must mint a new position NFT. State this consequence accurately in the
documentation and account for it in the mathematics.

Do not touch, modify, withdraw from, approve, or transfer the original
PONS-locked launch position.

## WETH holder-airdrop semantics

Read `AIRDROP_TOOLS.md` and implement the full code path yourself.

A WETH_AIRDROP action must:

1. allocate at most 12.5% of the currently reconciled creator-fee WETH reserve
   in total;
2. choose an integer number of recipients from 1 through 10, capped by the
   number of eligible holders;
3. select unique eligible DCR holders without replacement using an auditable,
   deterministic result derived from a future Robinhood Chain block hash that
   was fixed before that hash became known;
4. derive the eligibility rule, recipient-count rule, total allocation, and
   per-recipient allocation mathematically as part of the revised DCR theory;
5. explicitly analyze uniform-holder, balance-weighted, and anti-Sybil
   alternatives rather than silently adopting a manipulable rule;
6. exclude zero/dead addresses, the reserve wallet itself, the DCR token,
   canonical pool, PONS factory/locker, router, quoter, position manager, and
   addresses with zero balance at the finalized snapshot;
7. never rely on an operator-supplied recipient list or `Math.random()`;
8. transfer ordinary WETH directly to the selected recipients, confirm every
   receipt and balance delta, and publish the snapshot block, randomness anchor,
   eligible-set commitment, recipients, amounts, and transaction hashes;
9. persist the complete payout plan before the first transfer and resume only
   unpaid recipients after a crash, so no holder can be paid twice.

The holder index must be reconstructed from canonical DCR `Transfer` events
with bounded chunked queries, reorg handling, a durable cursor, and final
on-chain `balanceOf` reconciliation. It may synchronize in the background, but
WETH_AIRDROP must remain unavailable until the index is complete through its
declared finalized snapshot block. Blockscout may only be a cross-check.

## Capital and platform limits

- The only strategy capital is creator-fee WETH and creator-fee DCR in the
  resolved fee-recipient wallet.
- Native ETH is gas only. Never wrap, spend, allocate, or count native ETH as
  strategy capital.
- The agent may claim creator fees through the PONS locker.
- It cannot change the canonical pool, launch liquidity, AMM fee percentage,
  token supply logic, routing contracts, or PONS protocol parameters.
- A burn is an ERC-20 transfer to the conventional burn address; it reduces
  circulating supply but does not change the ERC-20 `totalSupply()` value.
- Validate all PONS identities and canonical pool metadata on every process
  start before signing.

## Production behavior that must be implemented inside the new agent

The supplied `PRODUCTION_HARDENING.md` records failures observed while running
your first project and the external runner changes that made its transaction
paths reliable. Incorporate the required behavior into your new agent itself.
The final strategy must not depend on an external monkey patch or a human
repairing failed actions.

In particular:

- evaluate on a randomly jittered 10–15 minute start-to-start cadence;
- persist the exact next-run timestamp and honor it after restarts so a restart
  cannot create an immediate duplicate cycle;
- use a token-specific state directory and support an explicit, documented
  migration from the supplied DCR v1 state without losing the price baseline;
- serialize transactions and persist cycle/action identifiers and confirmed
  transaction hashes so a crash or restart cannot repeat a confirmed economic
  action;
- use bounded recent log queries and a durable cursor; never require a
  full-chain scan before the first decision;
- obtain a fresh quote immediately before each swap, use a bounded slippage
  minimum, simulate, add a safe gas-limit buffer, wait for receipts, reconcile
  exact balance deltas, and permit at most one explicitly logged fresh-quote
  retry for a retryable router failure;
- distinguish a reverted transaction from a successful action and never report
  an intended or simulated action as executed;
- use exact temporary approvals and reliably restore every router and position
  manager allowance to zero on success and failure;
- make multi-transaction plans recoverable. For example, after a BUY succeeds
  but before its paired BURN or LP mint completes, restart recovery must resume
  the unfinished plan rather than buy again; an interrupted WETH_AIRDROP must
  resume only recipients without confirmed transfers;
- treat `NoFeesToCollect` as an ordinary condition;
- keep future cycles alive after RPC errors, dropped/replaced transactions,
  reorgs, or bounded execution failures;
- never perform more than one policy plan for the same cycle;
- preserve dry-run inspection as the default.

## Deliverable

Modify the supplied project into the complete DCR v2 implementation. Do not
only describe changes or return snippets.

The delivered project must include:

- the full revised mathematical derivation;
- complete TypeScript source for observations, decisions, claiming, BUY, rare
  SELL, BURN, PERMANENT_LP mint-and-lock, holder indexing, verifiable
  WETH_AIRDROP, recovery, persistence, CLI, and scheduling;
- machine-checkable Lean statements/proofs for the central controller
  properties that are realistically formalizable, including the 12.5% reserve
  bound and the asymmetric sell-admissibility property;
- unit tests, deterministic policy-grid tests, restart/idempotency tests, and
  failure-path tests;
- fork-based transaction-path tests for swap, burn, LP mint, NFT transfer to
  the burn address, WETH payouts to 1 and 10 unique holders, allowance cleanup,
  and recovery after interrupted LP and airdrop plans;
- `.env.example`, systemd service files, migration tooling, operational
  instructions, and an updated strategy document suitable for the public
  transparency website;
- no TODOs, placeholders, pseudocode, runtime calls to Aristotle, or missing
  pieces for the operator to implement.

Before returning the project, actually install dependencies and run typecheck,
tests, the production build, Lean checks, and a real read-only inspection
against Robinhood Chain. Mainnet fixtures are read-only: never broadcast a
transaction. Exercise signing paths only on a local fork with impersonated
accounts and deterministic fixtures.

Return the complete runnable project only after those checks pass. Include an
exact verification report listing every command run and its result.
