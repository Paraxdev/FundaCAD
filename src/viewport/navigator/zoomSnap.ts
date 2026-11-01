// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. Scaling
// about an anchor shifts a point by the log left, times its pixels from the anchor's pixel, times anchor depth over
// point depth, so the log that may be dropped follows from the nearest surface in view.

import type * as THREE from "three";
import { depthUnder, type AnchorContext } from "./anchor";
import { depthOf, project, type Frame, type Pose } from "./pose";

/** What a landing adds to its frame, on top of the spring's own step that frame. */
export const ZOOM_SNAP_PX = 0.1;

/** How many times the largest possible snap a zoom has left when it starts looking. */
export const SWEEP_FROM = 8;

const RAYS = 45;
const RAY_BUDGET_MS = 2;
const RAY_TRUST = 8;
const GOLDEN = 0.618033988749895;

/** The frame's corners, edge midpoints and centre, where a wall beside the eye is nearest, then points that share no
 *  column or row, so a bar of either direction wider than about a sixteenth of the frame meets one. */
function rayPixel(k: number, frame: Frame): { x: number; y: number } {
  if (k < 9) return { x: ((k % 3) / 2) * frame.width, y: (Math.floor(k / 3) / 2) * frame.height };
  const i = k - 8.5;
  return { x: (i / (RAYS - 9)) * frame.width, y: ((i * GOLDEN) % 1) * frame.height };
}

/** Looks for the nearest surface in view a budget at a time, as a model of many bodies can take milliseconds a ray. */
export class NearestSweep {
  private cast = 0;
  private seen: number | null = null;

  /** True once every ray is in. Always casts one, so a heavy model still gets there or the spring lands first. */
  advance(p: Pose, ctx: AnchorContext, budgetMs = RAY_BUDGET_MS): boolean {
    const until = performance.now() + budgetMs;
    while (this.cast < RAYS) {
      const { x, y } = rayPixel(this.cast++, ctx.frame);
      const d = depthUnder(p, ctx, x, y);
      if (d !== null && d > 0 && (this.seen === null || d < this.seen)) this.seen = d;
      if (performance.now() >= until) break;
    }
    return this.cast >= RAYS;
  }

  nearest(): number | null {
    return this.seen;
  }
}

/** The depth to answer to. Rays can pass between thin parts, so they are only trusted to within `RAY_TRUST`, less where
 *  `floor`, the parts' nearest depth in the frustum, shows nothing can be nearer. A part further inside still moves only
 *  its depth ratio over `RAY_TRUST` times the threshold. */
export function nearestBound(seen: number | null, floor: number, anchorDepth: number): number | null {
  if (Number.isNaN(floor)) return seen;
  const known = seen === null ? anchorDepth : Math.min(seen, anchorDepth);
  return Math.min(known, Math.max(floor, known / RAY_TRUST));
}

/** The log left that shifts nothing in view by more than `ZOOM_SNAP_PX`. */
export function zoomSnapLog(p: Pose, frame: Frame, anchor: THREE.Vector3, nearest: number | null): number {
  const at = project(p, frame, anchor);
  const reach = Math.hypot(Math.max(at.x, frame.width - at.x), Math.max(at.y, frame.height - at.y));
  const log = ZOOM_SNAP_PX / Math.max(reach, 1);
  if (p.ortho || nearest === null) return log;
  return log / Math.max(1, depthOf(p, anchor) / nearest);
}
