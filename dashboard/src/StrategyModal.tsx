import { useEffect, useRef } from "react";

interface StrategyModalProps {
  onClose: () => void;
  ticker: string;
}

function Formula({
  children,
  note
}: {
  children: string;
  note: string;
}) {
  return (
    <div className="strategy-formula">
      <code>{children}</code>
      <span>{note}</span>
    </div>
  );
}

export function StrategyModal({ onClose, ticker }: StrategyModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const activeElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      activeElement?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="strategy-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article
        aria-labelledby="strategy-title"
        aria-modal="true"
        className="strategy-modal"
        role="dialog"
      >
        <header className="strategy-modal-header">
          <div>
            <span className="text-micro">DCR / MATHEMATICAL SPECIFICATION</span>
            <h2 id="strategy-title">How the reservoir decides</h2>
          </div>
          <button
            aria-label="Close strategy explanation"
            className="strategy-close text-micro"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            CLOSE ×
          </button>
        </header>

        <div className="strategy-modal-body">
          <section className="strategy-intro">
            <p className="strategy-lead">
              Discrete Curvature Reservoir is a countercyclical feedback
              controller. It treats creator-fee WETH and {ticker} as two
              reservoirs, observes local price displacement, and trades against
              unusually sharp movement.
            </p>
            <p>
              It does not attempt to peg the price or predict a fair value.
              Its only chosen vector points opposite to the latest local price
              displacement: buy after a sufficiently sharp fall, sell after a
              sufficiently sharp rise, and otherwise hold.
            </p>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">01 / OBSERVE</div>
            <div>
              <h3>Measure signed price displacement</h3>
              <p>
                Uniswap V3 represents price through <code>s</code>, its exact
                integer <code>sqrtPriceX96</code>. DCR compares the latest value
                with the previous completed cycle without floating-point
                arithmetic.
              </p>
              <Formula note="dimensionless signed displacement, scaled by 10⁶">
                rₙ = 10⁶ · (sₙ² − sₙ₋₁²) / sₙ₋₁²
              </Formula>
              <p className="strategy-note">
                V3 quotes token1 per token0. When the launched token is token1,
                the sign is inverted so that negative <code>rₙ</code> always
                means the launched token fell against WETH.
              </p>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">02 / FILTER</div>
            <div>
              <h3>Build an adaptive dead zone</h3>
              <p>
                Small moves are treated as noise. The no-action threshold grows
                with recent absolute WETH swap flow relative to pool liquidity.
              </p>
              <Formula note="recent flow pressure relative to liquidity">
                qₙ = 10⁶ · Vₙ / (Lₙ + 1)
              </Formula>
              <Formula note="adaptive threshold; busier markets require a larger move">
                dₙ = 1500 + min(qₙ, 25000) / 5
              </Formula>
              <dl className="strategy-definitions">
                <div>
                  <dt>Vₙ</dt>
                  <dd>Absolute WETH swap flow observed since the last cursor.</dd>
                </div>
                <div>
                  <dt>Lₙ</dt>
                  <dd>Current canonical pool liquidity.</dd>
                </div>
                <div>
                  <dt>|rₙ| ≤ dₙ</dt>
                  <dd>The movement is inside the dead zone: HOLD.</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">03 / SIZE</div>
            <div>
              <h3>Convert excess curvature into bounded size</h3>
              <p>
                Only the displacement beyond the threshold matters. A cubic
                response stays quiet near the boundary but grows smoothly when
                displacement becomes exceptional.
              </p>
              <Formula note="displacement outside the dead zone">
                eₙ = max(|rₙ| − dₙ, 0)
              </Formula>
              <Formula note="cubic response energy">
                Cₙ = eₙ³ / (dₙ² + 1)
              </Formula>
              <Formula note="fraction of the relevant wallet balance">
                fₙ = clamp(Cₙ / 200, 25, 1250) / 10000
              </Formula>
              <p className="strategy-callout">
                When a trade signal exists, <strong>fₙ is between 0.25% and
                12.5%</strong>. The cap applies to each cycle and to the
                remaining balance of the asset being spent.
              </p>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">04 / ACT</div>
            <div>
              <h3>Move opposite to local price direction</h3>
              <div className="strategy-decisions">
                <div>
                  <span className="text-micro">rₙ &lt; −dₙ</span>
                  <strong className="decision-buy">BUY</strong>
                  <code>WETH spent = fₙ · Rᵂₙ</code>
                  <p>A sharp fall releases WETH demand into the token.</p>
                </div>
                <div>
                  <span className="text-micro">rₙ &gt; dₙ</span>
                  <strong className="decision-sell">SELL</strong>
                  <code>{ticker} sold = fₙ · Rᵀₙ</code>
                  <p>A sharp rise replenishes the WETH reservoir.</p>
                </div>
                <div>
                  <span className="text-micro">|rₙ| ≤ dₙ</span>
                  <strong>HOLD</strong>
                  <code>amount = 0</code>
                  <p>Ordinary movement produces no transaction.</p>
                </div>
              </div>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">05 / INVARIANT</div>
            <div>
              <h3>The mathematical idea</h3>
              <p>
                In Aristotle&apos;s idealized local-impact model, price
                displacement is <code>x</code>, control is <code>u = kx</code>,
                and the next displacement is <code>x′ = x − u</code>. With
                quadratic Lyapunov energy:
              </p>
              <Formula note="idealized contraction for 0 ≤ k ≤ 1">
                E′ = (x′)² = (1 − k)²x² ≤ x² = E
              </Formula>
              <p className="strategy-note">
                The controller therefore does not increase displacement energy
                in that simplified model. The contraction and reserve bound are
                machine-checked in Aristotle&apos;s Lean proof. Real markets
                include latency, fees, jumps, nonlinear impact, and adverse
                selection, so this is a local control invariant—not a profit or
                price-performance guarantee.
              </p>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">06 / EXECUTE</div>
            <div>
              <h3>How one live cycle runs</h3>
              <ol className="strategy-steps">
                <li>Revalidate chain 4663, PONS launch, pool, pair and fee recipient.</li>
                <li>Claim creator fees when signing is enabled and fees exist.</li>
                <li>Observe a bounded window, calculate DCR and choose BUY, SELL or HOLD.</li>
                <li>Request a fresh quote and require at least 99.25% of quoted output.</li>
                <li>Approve only the exact input, execute, confirm and reconcile balances.</li>
                <li>Wait a new random interval: Δt = 600 + 300U seconds, U ∈ [0, 1).</li>
              </ol>
            </div>
          </section>

          <section className="strategy-section strategy-reality">
            <div className="strategy-index text-micro">07 / REALITY</div>
            <div>
              <h3>What the agent actually controls</h3>
              <div className="strategy-reality-grid">
                <div>
                  <span className="text-micro">CONTROLLED</span>
                  <p>
                    The full WETH and {ticker} balances of the resolved
                    fee-recipient wallet. Assets manually sent to that same
                    wallet are indistinguishable from claimed fees.
                  </p>
                </div>
                <div>
                  <span className="text-micro">NOT SPENT AS STRATEGY CAPITAL</span>
                  <p>
                    Native ETH is not bought or sold by DCR. It remains in the
                    wallet to pay gas for claims, approvals, swaps and receipt
                    settlement.
                  </p>
                </div>
                <div>
                  <span className="text-micro">NOT CONTROLLED</span>
                  <p>
                    AMM parameters, liquidity, routing, token supply and
                    protocol fee percentage. DCR also does not select routine
                    burns or holder distributions.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer className="strategy-modal-footer text-micro">
          <span>MODEL: DISCRETE CURVATURE RESERVOIR</span>
          <span>ORIGIN: UNMODIFIED ARISTOTLE OUTPUT</span>
        </footer>
      </article>
    </div>
  );
}
