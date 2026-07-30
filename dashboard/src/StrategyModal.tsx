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
            <span className="text-micro">DCR V2 / MATHEMATICAL SPECIFICATION</span>
            <h2 id="strategy-title">How the reservoir allocates</h2>
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
              DCR v2 is a buy-biased, one-sided curvature controller for the
              creator-fee WETH and {ticker} reservoirs.
            </p>
            <p>
              Drawdowns become buy-admissible quickly. Selling requires both a
              much stronger upward displacement and excess token-denominated
              solvency. In calm markets, surplus is converted into burns,
              permanently locked liquidity, or WETH distributions to holders.
            </p>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">01 / OBSERVE</div>
            <div>
              <h3>Measure price curvature and flow pressure</h3>
              <p>
                The controller uses Uniswap V3&apos;s exact integer{" "}
                <code>sqrtPriceX96</code>, written as <code>s</code>. Its sign
                is oriented so a negative return always means {ticker} fell
                against WETH.
              </p>
              <Formula note="signed token return, scaled by 10⁶">
                rₙ = ±10⁶ · (sₙ² − sₙ₋₁²) / sₙ₋₁²
              </Formula>
              <Formula note="recent absolute WETH swap flow relative to live pool liquidity">
                qₙ = 10⁶ · Vₙ / (Lₙ + 1)
              </Formula>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">02 / FILTER</div>
            <div>
              <h3>Create an adaptive dead zone</h3>
              <p>
                Ordinary movement is treated as noise. Higher observed flow
                widens the threshold, so an active market must move further
                before a swap signal is accepted.
              </p>
              <Formula note="dimensionless adaptive displacement threshold">
                dₙ = 1500 + min(qₙ, 25000) / 5
              </Formula>
              <dl className="strategy-definitions">
                <div>
                  <dt>rₙ &lt; −dₙ</dt>
                  <dd>A token drawdown enters the buy cone.</dd>
                </div>
                <div>
                  <dt>|rₙ| ≤ dₙ</dt>
                  <dd>The market is calm; surplus allocation may run.</dd>
                </div>
                <div>
                  <dt>rₙ &gt; 4dₙ</dt>
                  <dd>Only then can the rare sell gate be considered.</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">03 / SIZE</div>
            <div>
              <h3>Turn exceptional displacement into bounded size</h3>
              <p>
                Only curvature beyond the dead zone contributes. A cubic
                response is quiet near the boundary and rises smoothly for
                exceptional movement.
              </p>
              <Formula note="excess displacement and cubic response energy">
                eₙ = max(|rₙ| − dₙ, 0), Cₙ = eₙ³ / (dₙ² + 1)
              </Formula>
              <Formula note="swap share of the asset being spent">
                fₙ = clamp(Cₙ / 200, 25, 1250) / 10000
              </Formula>
              <p className="strategy-callout">
                A BUY or SELL spends between <strong>0.25% and 12.5%</strong>{" "}
                of the relevant current reservoir in that cycle—never more.
              </p>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">04 / TRADE CONE</div>
            <div>
              <h3>Buy readily, sell only inside a strict solvency cone</h3>
              <div className="strategy-decisions">
                <div>
                  <span className="text-micro">rₙ &lt; −dₙ</span>
                  <strong className="decision-buy">BUY</strong>
                  <code>WETH spent = fₙ · Rᵂₙ</code>
                  <p>A qualifying drawdown deploys WETH into {ticker}.</p>
                </div>
                <div>
                  <span className="text-micro">
                    rₙ &gt; 4dₙ AND PₙRᵀₙ &gt; 2Rᵂₙ
                  </span>
                  <strong className="decision-sell">SELL</strong>
                  <code>{ticker} sold = fₙ · Rᵀₙ</code>
                  <p>
                    Even a rise is not enough: it must be extreme and the token
                    inventory must be worth over twice the WETH reserve.
                  </p>
                </div>
                <div>
                  <span className="text-micro">OTHERWISE</span>
                  <strong>HOLD</strong>
                  <code>swap amount = 0</code>
                  <p>
                    A positive move outside the narrow sell cone causes no
                    sale.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">05 / CALM ALLOCATION</div>
            <div>
              <h3>Route surplus without fighting a price shock</h3>
              <p>
                These gates are evaluated only when <code>|rₙ| ≤ dₙ</code>.
                Their order is deterministic.
              </p>
              <ol className="strategy-steps">
                <li>
                  If token value exceeds twice WETH, transfer{" "}
                  <strong>6.25% of {ticker}</strong> to the conventional burn
                  address. ERC-20 <code>totalSupply</code> remains unchanged.
                </li>
                <li>
                  If both reservoirs are balanced within a 2× band and flow
                  pressure is at least 2000, allocate up to{" "}
                  <strong>10% of each asset</strong> to a new live-range V3
                  position.
                </li>
                <li>
                  If WETH exceeds twice token value and the finalized holder
                  index is complete, distribute{" "}
                  <strong>6.25% of WETH</strong> equally to 1–10 selected
                  holders.
                </li>
              </ol>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">06 / LP + AIRDROP</div>
            <div>
              <h3>Make both allocation paths independently verifiable</h3>
              <p>
                LP bounds are centered on the current tick and widen with flow.
                The controller mints a fresh canonical-pool NFT, verifies its
                pair, fee, range, liquidity and ownership, then transfers that
                NFT to <code>0x…dEaD</code>. The launch position is explicitly
                rejected. The locked liquidity and its future fees are
                permanently inaccessible.
              </p>
              <p className="strategy-note">
                Holder selection starts from a finalized transfer index. A
                commitment is stored before a future block hash is known; after
                12 confirmations, unbiased rejection sampling chooses unique
                addresses. This is auditable uniform-address sampling, not
                balance weighting, and therefore cannot by itself prove
                personhood or eliminate Sybil splitting.
              </p>
            </div>
          </section>

          <section className="strategy-section">
            <div className="strategy-index text-micro">07 / CYCLE</div>
            <div>
              <h3>What happens every 10–15 minutes</h3>
              <ol className="strategy-steps">
                <li>Honor the exact persisted next-run timestamp after restart.</li>
                <li>Validate chain 4663, PONS contracts, pool and fee recipient.</li>
                <li>Resume any prepared transaction before allowing a new cycle.</li>
                <li>Advance the holder index by at most 1,500 blocks.</li>
                <li>Claim creator fees if any are available, then reread balances.</li>
                <li>Calculate DCR v2 and persist the decision and next timestamp.</li>
                <li>Execute, confirm receipts, reconcile balances and clear allowances.</li>
              </ol>
              <Formula note="fresh random delay persisted before the economic action">
                Δt = 600 + 300U seconds, U ∈ [0, 1)
              </Formula>
            </div>
          </section>

          <section className="strategy-section strategy-reality">
            <div className="strategy-index text-micro">08 / SAFETY</div>
            <div>
              <h3>Capital, execution and recovery boundaries</h3>
              <div className="strategy-reality-grid">
                <div>
                  <span className="text-micro">STRATEGY CAPITAL</span>
                  <p>
                    The fee-recipient wallet&apos;s WETH and {ticker} balances.
                    Manually transferred assets are indistinguishable from
                    claimed creator fees.
                  </p>
                </div>
                <div>
                  <span className="text-micro">GAS ONLY</span>
                  <p>
                    Native ETH is never bought, sold, burned, added to LP, or
                    distributed. It only pays transaction gas.
                  </p>
                </div>
                <div>
                  <span className="text-micro">FAIL CLOSED</span>
                  <p>
                    Prepared hashes and raw transactions are persisted before
                    broadcast. Restarts rebroadcast the exact transaction,
                    refuse overlapping cycles, and never silently retry a
                    failed airdrop recipient.
                  </p>
                </div>
              </div>
              <p className="strategy-note">
                Swaps use a fresh quote, 0.75% minimum-output tolerance, 20% gas
                estimate buffer, exact approvals and at most one fresh-quote
                retry. These controls reduce execution failure; they do not
                guarantee profit or token-price performance.
              </p>
            </div>
          </section>
        </div>

        <footer className="strategy-modal-footer text-micro">
          <span>MODEL: DCR V2 / ARISTOTLE-GENERATED BASELINE</span>
          <span>RUNTIME: FORK-TESTED + RECOVERY HARDENED</span>
        </footer>
      </article>
    </div>
  );
}
