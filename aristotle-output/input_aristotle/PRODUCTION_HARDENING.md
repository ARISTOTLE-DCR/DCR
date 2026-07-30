# DCR v1 production findings that v2 must internalize

This file records factual operational findings from the first DCR deployment.
It does not prescribe the revised mathematical policy.

## Transaction execution

- Raw provider gas estimates were occasionally too low for the deployed router.
  A 20% gas-limit buffer made both BUY and SELL reliable. Unused gas is not
  charged. Implement an equivalent bounded buffer inside the executor.
- A stale quote or a mined router revert could make a valid policy action fail.
  A single immediate retry with a fresh quote worked. The retry must retain the
  same cycle and action amount, be explicitly logged, and never become an
  unbounded loop.
- Approvals must be exact and temporary. Router and position-manager allowances
  must reconcile to zero after every completed or failed plan.
- Confirm success using receipts plus balance/event deltas, not the submitted
  transaction hash alone.

## Scheduling and restart behavior

- Restarting the original CLI immediately ran a new cycle. During an external
  one-off action this caused an unintended second policy action.
- The working mitigation persisted `nextRunAt` and delayed the CLI until that
  timestamp. DCR v2 must own this behavior natively and atomically.
- Runtime paths are token-specific. The production observer uses:
  `OBSERVER_DATA_DIR=./data/<lowercase-token-without-0x>`. State, journals,
  scheduler data, and recovery plans must resolve the same canonical
  token-specific path rather than assuming `./data`.
- Deployment and process restarts must not reset the current 10–15 minute
  schedule or create a second action.

## Observation

- The public RPC times out on very wide `eth_getLogs` ranges. The first run must
  use a bounded recent window and durable cursor, not scan millions of blocks.
- Recent WETH volume must be computed from canonical pool Swap events with
  correct token ordering. If the bounded query fails, the cycle must fail safe
  or use an explicitly documented degraded observation; it must not silently
  fabricate volume.

## State and idempotency

- The production DCR token is
  `0x29b9e5306CBC8e0E8e4C1d63FC85A843303E0c7A`.
  It may be used for read-only inspection only.
- The fee recipient is
  `0xFe884239Ab22cA90BB86a33120aD932bd52339F1`.
  Never request or embed its private key.
- Persist a cycle ID, intended plan, stage, transaction hashes, receipt blocks,
  and reconciled deltas before progressing between stages.
- After a crash, resume an unfinished BURN or LP-lock stage without repeating
  the preceding BUY or mint.
- A single process/service is expected, but code should still refuse overlapping
  cycles.

## Existing runner reference

`PRODUCTION_RUNNER_REFERENCE.ts` contains the deployed external runner that
added gas buffering, one fresh-quote retry, public event capture, and deferred
starts around the unchanged v1 agent. It is reference evidence only. DCR v2
must implement the required behavior directly and must not depend on importing
or monkey-patching that runner.
