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

end CurvatureReservoir
