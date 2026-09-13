// The lattice the move gizmo's handles snap to, tied to the grid on screen so
// zooming in gives finer steps and zooming out coarser ones.

import { gridStep } from "../sketch/planeGrid";
import { snap } from "../ui/units";
import { FINE_DIVISOR, MIN_STEP } from "./dragStep";

/** Move steps per minor grid cell: a 5 mm grid slides in 0.5 mm. */
export const MOVE_STEPS_PER_CELL = 10;

/** A ring turns in these steps, and in the fine step with Shift. */
export const ROTATE_STEP_DEG = 15;
export const ROTATE_FINE_DEG = 1;

/** Slide step in mm for the grid cell drawn at this zoom. */
export function gizmoMoveStep(worldPerPixel: number, fine = false): number {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return MIN_STEP;
  const step = gridStep(worldPerPixel, 0) / MOVE_STEPS_PER_CELL / (fine ? FINE_DIVISOR : 1);
  return Math.max(MIN_STEP, step);
}

/** Turn step in degrees. Fixed rather than tied to zoom: a step that followed
 *  the zoom came out at a degree or less and a turn felt unstepped. */
export function gizmoRotateStep(fine = false): number {
  return fine ? ROTATE_FINE_DEG : ROTATE_STEP_DEG;
}

/** Snap a resize factor so the dragged extent (`extent` mm before resizing)
 *  lands on whole slide steps. */
export function snapScaleFactor(factor: number, extent: number, moveStep: number): number {
  if (!(extent > 0) || !(moveStep > 0) || !Number.isFinite(factor)) return factor;
  const sized = Math.max(moveStep, snap(factor * extent, moveStep));
  return sized / extent;
}
