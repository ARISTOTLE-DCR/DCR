# One-shot PONS scanner model

## Objective and assumptions

The scanner estimates **current directional market state**, not future return. Its objective is to extract a direction from a six-hour finalized on-chain window while shrinking that direction toward neutral whenever the evidence is thin, concentrated, illiquid, incomplete, or too short. Missing observations are uncertainty, never negative evidence.

The six-hour horizon is long enough to contain many blocks without turning a one-shot response into a historical index. A nested one-hour horizon measures whether direction is accelerating. Both windows are found by binary-searching actual block timestamps; no block-time assumption is made. Eight confirmations are excluded by default for reorg safety.

Only canonical PONS token/pool state and V3 `Swap` logs are used. V3 active liquidity is converted to a local virtual WETH depth proxy; it is not total-value-locked.

## Exact price and observations

Let `s` be `sqrtPriceX96`, `Q = 2^96`, and `z = +1` when the PONS token is token0 and `z = -1` otherwise. WETH per token is the exact rational

- `p = s²/Q²` for token0;
- `p = Q²/s²` for token1.

All raw amounts and price ratios are computed with `bigint`; decimal text is made by integer long division. For endpoints `a,b`, the return in parts per million is computed directly as `(p_b/p_a - 1) × 10^6` using integer products, without binary floating-point price conversion.

The normalized observations are:

1. **Momentum** `M`: saturated six-hour return, `100 r/(|r|+0.08)`.
2. **Recent momentum** `R`: saturated one-hour return, `100 r₁/(|r₁|+0.03)`.
3. **Flow pressure** `F`: signed net WETH flow divided by absolute WETH flow, in `[-100,100]`. V3 signed pool deltas determine direction.
4. **Impulse** `I = clamp(R - M/2)`: recent acceleration relative to the longer move.
5. **Breadth** `B = 100(1-exp(-u/8))`, where `u` is distinct swap transactions.
6. **Depth** `D = 100v/(v+5 WETH)`, where `v` is local virtual WETH implied by active liquidity and current Q96 price.
7. **Activity** `A = 100(1-exp(-n/12))`, where `n` is observed swaps.

Implementation rounds these expressions deterministically to integer points. Floating point is used only for bounded dimensionless `exp` evaluations after raw blockchain quantities have been normalized to safe counts; raw amounts and Q96 calculations never use it.

## Direction, quality, confidence, and score

The latent direction is

`G = 0.50 M + 0.30 F + 0.20 I`.

These weights follow the objective: endpoint price displacement is the direct market-state statistic; executed net flow is independent confirmation; acceleration gets the remaining weight because it is informative but noisier.

Market quality is separate:

`Qm = 0.45 D + 0.30 B + 0.25 A`.

Depth receives the largest weight because a move against meaningful executable liquidity is harder to create. Breadth and activity prevent one trader or one swap from manufacturing a strong label.

Data confidence is the product of log-query completeness, fraction of the requested time span actually covered, and field availability. Actual coverage begins at the latest of the six-hour boundary, the verified token/pool launch, and the earliest usable swap observation; pre-launch time never counts as observed history. Failed log chunks reduce completeness. An absent metric contributes no directional points and lowers availability. Thus missing data pulls the result toward neutral rather than bearish.

Reliability is `H = min(Qm, confidence)`. The final normalized score is

`S = round(G × H/100)`, clamped to `[-100,100]`.

This multiplicative shrinkage is the central design choice: even extreme direction cannot become strongly positive or negative without both market quality and trustworthy observation.

## Classification

- `S >= 55`: **STRONG BULLISH**
- `20 <= S < 55`: **BULLISH**
- `-20 < S < 20`: **NEUTRAL**
- `-55 < S <= -20`: **BEARISH**
- `S <= -55`: **STRONG BEARISH**

The label is a quantitative market-state summary, not personalized financial advice or a guarantee.

## Acquisition and safety

The scanner checks chain ID 4663, contract code, membership in exactly one of the immutable active and legacy official PONS factories, token-reported launch factory and version-specific identity getters, token-reported pool, canonical V3 factory pool, WETH pair, fee tier, token0/token1 ordering, and PONS orientation. Metadata is optional and sanitized.

Log reads use adaptive bounded chunks (50–5,000 blocks), at most 80 requests, per-request timeouts, and partial-completeness accounting. Timestamp binary search bounds old and new launches without a full-chain scan. The scanner has no signer and contains no transaction call. Completed reports retain identity `(chainId, checksummed token, finalizedBlock)` and are cached for 120 seconds; a same-token request within TTL reuses the latest report before fetching a new finalized tip. Same-token scans are coalesced, and only two scans run globally by default.
