// The lattice a manipulator drag is quantised to: press/pull, move, offset
// plane, section, and the fillet/chamfer scrub all round their value to this.
//
// It was `niceStep(worldPerPixel * 8)` — one step per eight screen pixels. On a
// freshly fitted 60mm part that is world-per-pixel 0.143mm, so the step came out
// at 1mm and a face could only ever be pushed a whole millimetre at a time.
// Measured, not assumed: 1mm at 7.0px per step, and you had to wheel in ten
// notches before 0.1mm became reachable at all.
//
// One step per PIXEL instead. The same fitted part then lands on 0.1mm, which is
// the resolution you actually model at, and the rule stays proportional to the
// zoom in both directions:
//
//   world/px    step      px per step
//   1.4         2         0.7      zoomed out: coarse, because 0.1mm is invisible
//   0.14        0.1       0.7      a fitted hand-sized part
//   0.015       0.01      0.7      wheeled in ten notches
//   0.0016      0.002     0.8      thirty notches
//
// So "how fine is a drag" answers itself by zooming, which is the one control
// every user already has and already reaches for. Nothing else has to be set.
//
// A step under a micron is not a finer drag, it is a stuck one: `snap()` rounds
// through `round()`, which quantises to 0.001, so a 0.0001 lattice collapses onto
// every thousandth of a millimetre anyway and the drag stops responding between
// them. MIN_STEP names that floor rather than leaving it to be rediscovered.

import { niceStep } from "../ui/units";

/** Screen pixels per lattice step. One: the drag resolves what the screen
 *  resolves, and the "nice" rounding below keeps the number legible. */
export const DRAG_GRANULARITY_PX = 1;

/** Shift divides the step by this. The zoom is the main control, but a
 *  precision modifier costs nothing and saves a wheel-in-wheel-back round trip
 *  when the view is already framed the way you want it. */
export const FINE_DIVISOR = 10;

/** Finest lattice that is a lattice at all — see the note above about round().
 *  One micron, which is finer than any printer or cutter this is aimed at. */
export const MIN_STEP = 0.001;

/** The step a drag should snap to at this zoom, in mm.
 *
 *  `fine` is the Shift modifier: a tenth of the step, still floored at MIN_STEP.
 */
export function dragStep(worldPerPixel: number, fine = false): number {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return MIN_STEP;
  const step = niceStep(worldPerPixel * DRAG_GRANULARITY_PX) / (fine ? FINE_DIVISOR : 1);
  return Math.max(MIN_STEP, step);
}
