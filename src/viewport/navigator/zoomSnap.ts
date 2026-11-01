// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. Scaling
// about an anchor shifts a point by the log left, times its pixels from the anchor's pixel, times anchor depth over
// point depth, so the log that may be dropped follows from the nearest surface in view.

import type * as THREE from "three";
import { depthUnder, type AnchorContext } from "./anchor";
import { depthOf, project, type Frame, type Pose } from "./pose";

export const ZOOM_SNAP_PX = 0.1;

const GRID_X = 9;
const GRID_Y = 5;

/** The nearest surface over a grid reaching the frame's edges, where a wall beside the eye is nearest. */
export function nearestDepth(p: Pose, ctx: AnchorContext): number | null {
  let nearest: number | null = null;
  for (let j = 0; j < GRID_Y; j++) {
    for (let i = 0; i < GRID_X; i++) {
      const x = (i / (GRID_X - 1)) * ctx.frame.width;
      const y = (j / (GRID_Y - 1)) * ctx.frame.height;
      const d = depthUnder(p, ctx, x, y);
      if (d !== null && d > 0 && (nearest === null || d < nearest)) nearest = d;
    }
  }
  return nearest;
}

/** The log left that shifts nothing in view by more than `ZOOM_SNAP_PX`. */
export function zoomSnapLog(p: Pose, frame: Frame, anchor: THREE.Vector3, nearest: number | null): number {
  const at = project(p, frame, anchor);
  const reach = Math.hypot(Math.max(at.x, frame.width - at.x), Math.max(at.y, frame.height - at.y));
  const log = ZOOM_SNAP_PX / Math.max(reach, 1);
  if (p.ortho || nearest === null) return log;
  return log / Math.max(1, depthOf(p, anchor) / nearest);
}
