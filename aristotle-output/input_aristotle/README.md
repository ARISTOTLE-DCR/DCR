This project was edited by [Aristotle](https://aristotle.harmonic.fun).

To cite Aristotle:
- Tag @Aristotle-Harmonic on GitHub PRs/issues
- Add as co-author to commits:
```
Co-authored-by: Aristotle (Harmonic) <aristotle-harmonic@harmonic.fun>
```

# PONS Curvature Reservoir

A complete, dry-run-first creator-fee agent for Robinhood Chain (chain 4663).
It controls only creator-fee assets. It never changes the AMM, supply, routing,
or protocol fee.

## Mathematical model

### Discrete Curvature Reservoir (DCR)

Let `p_n` be the exact V3 WETH/token price, `L_n` pool liquidity, `V_n` recent
absolute WETH swap flow, and `R^W_n,R^T_n` the creator's WETH and token
reservoirs. Define the dimensionless signed displacement without floating point
by

`r_n = 10^6 (s_n²-s_(n-1)²)/s_(n-1)²`,

where `s` is `sqrtPriceX96`; both the displacement sign and exact rational
valuation are inverted when the token is token1. Define market pressure `q_n=10^6 V_n/(L_n+1)` and adaptive dead-zone
`d_n=1500+min(q_n,25000)/5`. The excess curvature is
`e_n=max(|r_n|-d_n,0)`, and the response energy is cubic:
`C_n=e_n³/(d_n²+1)`. The spend fraction is

`f_n = clamp(C_n/200, 25, 1250) / 10000`.

If `r_n<0`, DCR spends `f_n R^W_n` to buy tokens. If `r_n>0`, it sells
`f_n R^T_n`. Inside the dead-zone it does nothing. Thus the creator-fee stream
forms a passive, countercyclical reservoir: falls release WETH demand; rises
harvest token inventory back into WETH. A cubic response is near-zero around
noise yet grows smoothly under exceptional displacement. The cap preserves at
least 7/8 of either reservoir each cycle, so no single observation can exhaust
it.

This is not a price peg and makes no profit claim. It is a feedback geometry:
the only chosen vector is antiparallel to observed local price displacement.
Under the idealized local-impact equation `x' = x-u`, choosing `u=kx` with
`0≤k≤1` weakly contracts the quadratic Lyapunov energy `E=x²`. That contraction
is machine-checked in `RequestProject/Main.lean`. Real markets have delays,
fees, jumps, adverse selection, and nonlinear impact, so the theorem is a local
control invariant—not a market-performance guarantee.

### Mechanics implied by DCR

Creator fees accumulate at the resolved recipient. The agent claims them when
signing is explicitly enabled, observes only the latest 500-block bounded
window, and chooses buy/sell/hold. It does not add arbitrary holder rewards or
burn routinely: neither follows from curvature contraction. Every amount is a
`bigint`; prices remain integer rationals. First run establishes a baseline and
holds, while still producing a complete observation immediately.

## Install and run

Requires Node.js 20+.

```sh
npm install
cp .env.example .env
# set TOKEN_ADDRESS; optionally set CREATOR_PRIVATE_KEY and RPC_URL
npm run typecheck
npm test
npm run build
npm run inspect             # one live, non-signing cycle
npm start                   # continuous 10–15 minute jittered cadence
```

Dry-run is the default even if a key is present. To permit transactions, set
`SIGNING_ENABLED=true`. The signer must equal the locker's resolved creator-fee
recipient. The documented public fixture can never sign.

## Transaction safety

Each cycle revalidates chain, factory, locker, launch, pool, pair, recipient,
and balances. Claims and swaps are simulated before sending. Swaps use a fresh
quote, 0.75% maximum quote slippage, exact temporary approval (zeroed before
and after), receipt confirmation, and input/output balance reconciliation.
Burn support is similarly simulated and reconciled, although DCR does not
select it. Reverts, no-fee states, dropped/replaced transactions, quote failure,
and RPC errors become bounded failures; the next scheduled cycle continues.
State is atomically replaced on disk. Failed execution never fabricates a
successful state transition.

## Files

- `src/math.ts`: integer DCR policy
- `src/chain.ts`: bounded observations and identity validation
- `src/executor.ts`: guarded transactions and reconciliation
- `src/cli.ts`: durable randomized scheduler
- `test/`: deterministic policy/failure-edge tests
- `RequestProject/Main.lean`: formal contraction and reserve theorems

Private keys remain local environment variables. This software is experimental,
not financial advice; operators remain responsible for key security, gas, and
transaction consequences.
