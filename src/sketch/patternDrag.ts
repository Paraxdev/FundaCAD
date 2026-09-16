// What a drag around a circular pattern's centre means for its total sweep.
//
// The measurement is one atan2 difference, what earns it a file of its own is
// that the cursor alone cannot answer the question. An angle read straight off
// the cursor lives in (-180,180], so the moment the drag passes half a turn it
// flips sign and the sweep collapses back toward zero, when the user dragging
// the long way round is reaching for the one value this gesture exists to
// reach: a full 360. The reading therefore has to be unwrapped against the last
// one, which makes the history an INPUT here rather than state hidden in
// PatternFlow, and that is also what lets vitest pin the rules down without a
// canvas, a pointer or a sketch (see escapeLayers.ts for the same idiom).

/** One cursor sample, in sketch mm and degrees. Plain numbers, not vectors: the
 *  caller owns the geometry types, this file only owns the rule. */
export interface PatternSweepInput {
  /** the pattern centre, where the user clicked */
  cx: number;
  cy: number;
  /** the first source entity's representative point, what 0 degrees means */
  sx: number;
  sy: number;
  /** the cursor */
  px: number;
  py: number;
  /** the sweep last reported for this drag, null on its first sample */
  prev: number | null;
  /** Alt: follow the cursor exactly, no snapping */
  free?: boolean;
}

/** a full turn, and the limit in both directions */
const FULL = 360;
/** the snap grid, the angles a pattern is actually laid out on */
const STEP = 15;
/** how close to a full turn still counts as one, wider than half a STEP so the
 *  common case does not need the cursor placed to the degree */
const FULL_SNAP = 8;
/** below this the direction is noise, not a direction */
const MIN_RADIUS = 1e-6;

const clampTurn = (v: number) => Math.max(-FULL, Math.min(FULL, v));

/** The snap a pattern drag uses for a bare direction, shared so a row and a
 *  sweep land on the same angles. Alt passes the cursor's own reading through. */
export function snapAngleDeg(deg: number, free?: boolean): number {
  if (free) return deg;
  const v = Math.round(deg / STEP) * STEP;
  return v === 0 ? 0 : v; // a snapped -0 would be written into the document as one
}

/** The new total sweep in degrees, or null when there is no angle to read
 *  (source or cursor sitting on the centre), which leaves the caller on its
 *  current value rather than jumping it somewhere arbitrary. */
export function patternSweepDeg(i: PatternSweepInput): number | null {
  const sdx = i.sx - i.cx, sdy = i.sy - i.cy;
  const pdx = i.px - i.cx, pdy = i.py - i.cy;
  if (!(Math.hypot(sdx, sdy) > MIN_RADIUS) || !(Math.hypot(pdx, pdy) > MIN_RADIUS)) return null;
  let raw = ((Math.atan2(pdy, pdx) - Math.atan2(sdy, sdx)) * 180) / Math.PI;
  while (raw > 180) raw -= FULL;
  while (raw <= -180) raw += FULL;
  const prev = i.prev;
  // the turn of `raw` nearest the last reading: past +/-180 that is the next one
  // up, so the sweep keeps growing instead of flipping sign
  const v = clampTurn(prev != null && Number.isFinite(prev) ? raw + FULL * Math.round((prev - raw) / FULL) : raw);
  if (i.free) return v;
  if (FULL - Math.abs(v) <= FULL_SNAP) return v < 0 ? -FULL : FULL;
  return clampTurn(Math.round(v / STEP) * STEP);
}

/** How far from the centre dot, in screen pixels, a press still grabs it. */
export const CENTRE_GRAB_PX = 12;

/** Whether a press at `pointer` grabs the centre dot drawn at `dot`, both in
 *  client pixels. A dot that did not project (null) cannot be grabbed. */
export function nearCentreDot(
  dot: { x: number; y: number } | null,
  pointer: { x: number; y: number },
  radiusPx = CENTRE_GRAB_PX,
): boolean {
  if (!dot || !Number.isFinite(dot.x) || !Number.isFinite(dot.y)) return false;
  return Math.hypot(pointer.x - dot.x, pointer.y - dot.y) <= radiusPx;
}

/** Where a circular pattern starts centred: the mean of the selected sources'
 *  representative points. Sources that no longer resolve are skipped, and with
 *  none left there is no centre to offer. */
export function selectionCentre(
  points: readonly ({ x: number; y: number } | null)[],
): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    sx += p.x;
    sy += p.y;
    n++;
  }
  return n ? { x: sx / n, y: sy / n } : null;
}
