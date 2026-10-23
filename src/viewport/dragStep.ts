// The lattice every manipulator drag rounds to: one step per screen pixel, niced, so a fitted hand sized part drags in
// 0.1mm steps and zooming sets how fine a drag is.

import { niceStep } from "../ui/units";

/** One: the drag resolves what the screen resolves. */
export const DRAG_GRANULARITY_PX = 1;

/** Shift divides the step by this, which saves a wheel in and back out when the view is already framed. */
export const FINE_DIVISOR = 10;

/** One micron. A finer lattice sticks: snap() rounds through round(), which quantises to 0.001. */
export const MIN_STEP = 0.001;

/** In mm. `fine` is Shift, a tenth of the step, still floored at MIN_STEP. */
export function dragStep(worldPerPixel: number, fine = false): number {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return MIN_STEP;
  const step = niceStep(worldPerPixel * DRAG_GRANULARITY_PX) / (fine ? FINE_DIVISOR : 1);
  return Math.max(MIN_STEP, step);
}
