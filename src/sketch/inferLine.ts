// Deciding whether a freshly drawn line was meant to be horizontal or vertical.
//
// The rule was a 3 degree tolerance: draw a line within 3 degrees of an axis and
// it is snapped exactly onto it and the constraint recorded. That is the right
// guess when there is nothing better to go on, and it is the WRONG one when
// there is, because it silently destroys a deliberate offset.
//
// With grid snapping on, both endpoints land on the lattice, and the lattice is
// a statement of intent. A line from (0, 0) to (200, 5) with a 5mm grid was
// drawn one cell up: it is 1.43 degrees off horizontal, well inside the
// tolerance, so the guess flattened it and the 5mm rise the user had deliberately
// snapped to was gone. Nothing said so.
//
// So when the grid has already answered, the guess does not run:
//
//   both endpoints on the lattice, same y   ->  horizontal, exactly, no guessing
//   both endpoints on the lattice, same x   ->  vertical
//   both endpoints on the lattice, neither  ->  NOTHING. The user placed those
//                                               two cells on purpose.
//   anything else                           ->  the 3 degree guess, as before
//
// This can only ever record FEWER constraints than the old rule, never more: a
// line whose endpoints share a y is exactly 0 degrees and the tolerance would
// have caught it anyway. So it cannot introduce a constraint that fights an
// existing one, which is the hazard in this area.

/** Angular tolerance, in degrees, for the guess that runs when the grid has not
 *  already answered. Mainstream MCAD auto-constrain behaves the same way. */
export const INFER_TOL_DEG = 3;

export type InferredDirection = "horizontal" | "vertical" | null;

/** Is `v` on a lattice of spacing `step`?
 *
 *  The tolerance is relative to the step, not absolute: the lattice is 0.01mm at
 *  one zoom and 50mm at another, and a fixed epsilon is either uselessly tight
 *  at one end or meaninglessly loose at the other. */
export function onLattice(v: number, step: number): boolean {
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(v)) return false;
  const k = v / step;
  return Math.abs(k - Math.round(k)) <= 1e-6;
}

/** Which axis constraint a line should carry, if any.
 *
 *  `step` is the live snap lattice, or 0 when grid snapping is off, in which
 *  case the angular guess is the only rule available.
 */
export function inferLineDirection(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  step: number,
  tolDeg: number = INFER_TOL_DEG,
): InferredDirection {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

  const gridded =
    step > 0 &&
    onLattice(x1, step) && onLattice(y1, step) &&
    onLattice(x2, step) && onLattice(y2, step);

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
