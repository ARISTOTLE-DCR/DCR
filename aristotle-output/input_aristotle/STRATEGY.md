# DCR v2: one-sided curvature and permanent capital

DCR v2 preserves v1's integer displacement `r = 10^6(s²-s₋²)/s₋²`, orientation correction, flow pressure and adaptive dead-zone `d = 1500 + min(q,25000)/5`. Its cubic response remains `C=(|r|-d)³/(d²+1)` and each swap spends `clamp(C/200,25,1250)` basis points.

The extension is a **one-sided solvency cone**. A drawdown is buy-admissible at `r < -d`. A sell needs both `r > 4d` and token inventory valued at the live rational price exceeding twice WETH inventory. Thus positive curvature alone is insufficient. The sell projection is properly contained in the positive-curvature region: for `d>0`, `r=2d` is beyond the ordinary positive dead-zone but not sell-admissible. `RequestProject/Main.lean` proves containment and strictness.

In calm states (`|r|≤d`) the reservoir minimizes inaccessible surplus through three deterministic allocations:

* token value above twice WETH: transfer 6.25% of token inventory to the conventional burn address;
* balanced inventories under meaningful flow: commit 10% of each asset to a newly minted, live-tick-centered V3 position whose half-width grows with flow pressure;
* WETH above twice token value: distribute 6.25% WETH to 1–10 finalized holders, but only when the canonical holder index is complete.

Every allocation is below 12.5%; LP is bounded independently in both assets. Burning does not alter ERC-20 `totalSupply`. Permanent LP mints a separate NFT in the verified canonical pool, checks pair, fee, ticks, liquidity and initial ownership, then transfers it with `transferFrom` to `0x…dEaD`. This is an irreversible ownership lock, not ERC-721 destruction: liquidity and all future fees become inaccessible, so each later allocation mints a new NFT. The original PONS launch position ID is explicitly rejected.

## Holder selection

Transfers are indexed from the configured launch block in bounded chunks with a persisted finalized cursor. Candidates are canonically sorted, excluded system/dead/reserve addresses are removed, and every positive indexed balance is reconciled with historical `balanceOf` at the snapshot. An eligible-set commitment and a future anchor block are persisted before its hash is known. After 12 confirmations, rejection sampling from a hash-derived stream chooses unique addresses without modulo bias.

Uniform-holder sampling makes the rule auditable and avoids entrenching whales; balance weighting would systematically favor large balances. Uniform addresses remain susceptible to Sybil splitting. DCR mitigates, but cannot eliminate, that limitation through a finalized snapshot fixed before future randomness and a low recipient cap; an address-only chain cannot prove personhood. Operator lists and JavaScript randomness are never used. Payouts are equal apart from integer remainder and the full plan is persisted before transfer one.

## Safety and recovery

Only reconciled creator-fee token/WETH balances are capital; native ETH is gas only. Start-up verifies chain, factory, locker, position manager, launch pair and canonical pool. Swaps use immediate quotes, 0.75% minimums, simulation, a 20% gas buffer, receipt/delta checks, exact temporary approvals, and at most one fresh-quote retry. LP checks both assets and zeros both allowances. Airdrops persist per-recipient submitted/confirmed state and resume only unpaid entries.

State and journals are token-specific. Cycle IDs, intended action, stage, hashes and the exact next start time are atomically persisted. Restarts honor the 10–15 minute schedule and refuse overlap. `NoFeesToCollect` is ordinary. Dry-run remains default.
