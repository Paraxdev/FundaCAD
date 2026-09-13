// The lattice the move gizmo's handles snap to, tied to the grid on screen so
// zooming in gives finer steps and zooming out coarser ones.

import { gridStep } from "../sketch/planeGrid";
import { snap } from "../ui/units";
import { FINE_DIVISOR, MIN_STEP } from "./dragStep";

/** Move steps per minor grid cell: a 5 mm grid slides in 0.5 mm. */
export const MOVE_STEPS_PER_CELL = 10;

/** Rotation steps, coarsest first. */
export const ROTATE_LADDER_DEG = [45, 15, 5, 1, 0.5, 0.1] as const;

/** Slide step in mm for the grid cell drawn at this zoom. */
export function gizmoMoveStep(worldPerPixel: number, fine = false): number {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return MIN_STEP;
  const step = gridStep(worldPerPixel, 0) / MOVE_STEPS_PER_CELL / (fine ? FINE_DIVISOR : 1);
  return Math.max(MIN_STEP, step);
}

/** Turn step in degrees: the finest rung that still moves the selection's
 *  farthest point (`radius` mm from the pivot) by at least one slide step. */
export function gizmoRotateStep(moveStep: number, radius: number, fine = false): number {
  const ladder = ROTATE_LADDER_DEG;
  let at = 1; // 15 degrees when there is nothing to measure against
  if (moveStep > 0 && radius > 0 && Number.isFinite(radius)) {
    at = 0;
    for (let i = 0; i < ladder.length; i++) {
      if ((radius * ladder[i]! * Math.PI) / 180 >= moveStep) at = i;
    }
  }
  if (fine) at = Math.min(ladder.length - 1, at + 1);
  return ladder[at]!;
}

/** Snap a resize factor so the dragged extent (`extent` mm before resizing)
 *  lands on whole slide steps. */
export function snapScaleFactor(factor: number, extent: number, moveStep: number): number {
  if (!(extent > 0) || !(moveStep > 0) || !Number.isFinite(factor)) return factor;
  const sized = Math.max(moveStep, snap(factor * extent, moveStep));
  return sized / extent;
}
