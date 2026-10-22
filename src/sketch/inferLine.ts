// Whether a fresh line was meant horizontal or vertical. With grid snap on the lattice is intent: endpoints sharing
// y or x are exact, a deliberate one-cell offset gets nothing; otherwise the 3 degree guess runs. This only ever
// records fewer constraints than the guess alone, so it cannot fight an existing one.

/** Degrees, for the guess that runs when the grid has not answered; mainstream MCAD behaves the same. */
export const INFER_TOL_DEG = 3;

export type InferredDirection = "horizontal" | "vertical" | null;

/** Tolerance relative to `step`: the lattice is 0.01mm at one zoom and 50mm at another. */
export function onLattice(v: number, step: number): boolean {
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(v)) return false;
  const k = v / step;
  return Math.abs(k - Math.round(k)) <= 1e-6;
}

/** `step` is the snap lattice, 0 with grid snap off. `tolDeg` 0 turns the guess off but keeps the exact rules, for
 *  a closing segment whose direction the user did not choose. */
export function inferLineDirection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  step: number,
  tolDeg: number = INFER_TOL_DEG,
): InferredDirection {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

  const gridded = step > 0 && onLattice(x1, step) && onLattice(y1, step) && onLattice(x2, step) && onLattice(y2, step);

  if (gridded) {
    // Exact, and exhaustive: a lattice point is on some line in both axes, so
    // "neither coordinate matches" is a deliberate diagonal, not an unclear one.
    if (y1 === y2 && x1 !== x2) return "horizontal";
    if (x1 === x2 && y1 !== y2) return "vertical";
    return null;
  }

  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const norm = ((ang % 180) + 180) % 180; // 0..180
  if (Math.min(norm, 180 - norm) <= tolDeg) return "horizontal";
  if (Math.abs(norm - 90) <= tolDeg) return "vertical";
  return null;
}
