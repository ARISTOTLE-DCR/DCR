import Mathlib

/-!
# Discrete Curvature Reservoir invariants

The idealized one-step controller observes displacement `x` and applies an
antiparallel correction `k*x`.  These theorems certify the local quadratic
energy contraction and the integer reserve-preservation bound used by the
agent's 12.5% per-cycle cap.
-/

set_option autoImplicit false

namespace CurvatureReservoir

/-- An antiparallel correction with gain in `[0,1]` cannot increase quadratic
Lyapunov energy. -/
theorem quadratic_energy_contracts (x k : ℝ) (hk0 : 0 ≤ k) (hk1 : k ≤ 1) :
    (x - k * x) ^ 2 ≤ x ^ 2 := by
  have h : 0 ≤ k * (2 - k) := mul_nonneg hk0 (by linarith)
  nlinarith [sq_nonneg x]

/-- Any integer spend capped at one eighth preserves at least seven eighths
of the reserve.  The implementation establishes the premise by clamping its
basis-point fraction to 1250. -/
theorem reserve_preserved (r spent : ℕ) (hspent : 8 * spent ≤ r) :
    7 * r ≤ 8 * (r - spent) := by
  omega

/-- The implementation's basis-point formula satisfies the abstract spend cap. -/
theorem basis_point_spend_cap (r b : ℕ) (hb : b ≤ 1250) :
    8 * (r * b / 10000) ≤ r := by
  have hfloor : 10000 * (r * b / 10000) ≤ r * b := Nat.mul_div_le _ _
  have hprod : r * b ≤ r * 1250 := Nat.mul_le_mul_left r hb
  nlinarith

/-- DCR v2's sell cone (`r > 4d`) lies inside the positive-curvature
region (`r > d`) whenever the adaptive dead-zone is nonnegative. -/
theorem sell_admissible_implies_positive (r d : ℝ) (hd : 0 ≤ d)
    (hsell : 4 * d < r) : d < r := by
  linarith

/-- The containment is strict and meaningful for every positive dead-zone:
`2d` is positive curvature beyond `d`, but is excluded by the `4d` sell gate. -/
theorem sell_cone_strict (d : ℝ) (hd : 0 < d) :
    d < 2 * d ∧ ¬ (4 * d < 2 * d) := by
  constructor <;> linarith

/-- A one-sixteenth irreversible allocation (burn or airdrop) obeys the
one-eighth safety envelope. -/
theorem sixteenth_allocation_safe (r : ℕ) :
    8 * (r * 625 / 10000) ≤ r := by
  exact basis_point_spend_cap r 625 (by omega)

/-- A one-tenth permanent-LP allocation of either asset obeys the same cap. -/
theorem tenth_allocation_safe (r : ℕ) :
    8 * (r * 1000 / 10000) ≤ r := by
  exact basis_point_spend_cap r 1000 (by omega)

end CurvatureReservoir
