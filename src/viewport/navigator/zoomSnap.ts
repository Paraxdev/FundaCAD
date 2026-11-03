// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. Scaling
// about an anchor shifts a point by the log left, times its pixels from the anchor's pixel, times anchor depth over
// point depth, so the log that may be dropped follows from the nearest surface in view.

import * as THREE from "three";
import { depthUnder, visibleNearDepth, type AnchorContext } from "./anchor";
import { depthOf, eyeOf, project, type Frame, type Pose } from "./pose";

/** What a landing adds to its frame, on top of the spring's own step that frame. */
export const ZOOM_SNAP_PX = 0.1;

/** How many times the largest possible snap a zoom has left when it starts looking. */
export const SWEEP_FROM = 8;

const RAYS = 45;
const RAY_BUDGET_MS = 2;
const RAY_TRUST = 8;
const GOLDEN = 0.618033988749895;
const eye = new THREE.Vector3();

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
  private frames = 0;
  private gaveUp = false;
  private wasSlow = false;
  private seen: number | null = null;

  /** `goal` is the zoom's goal when the look started, for telling when a stream of small steps has outrun it. `before`
   *  is the rays a frame an earlier look managed, 0 for none, so a slow model is known before a ray, or after one when
   *  `beforeHere` is false, as that look was on an earlier model. */
  constructor(
    readonly goal = 0,
    private readonly before = 0,
    private readonly beforeHere = true,
  ) {}

  /** True once every ray is in. Casts at least one each frame, until the rest of them, at the pace so far, would come
   *  after `framesLeft()`, when the spring has landed anyway. */
  advance(p: Pose, ctx: AnchorContext, framesLeft: () => number, budgetMs = RAY_BUDGET_MS): boolean {
    if (this.cast >= RAYS) return true;
    if (this.gaveUp) return false;
    let left: number | undefined;
    const leftNow = () => (left ??= framesLeft());
    if (this.frames === 0 && this.before > 0) {
      this.wasSlow = this.late(this.before, leftNow);
      this.gaveUp = this.wasSlow && this.beforeHere;
      if (this.gaveUp) return false;
    }
    this.frames++;
    const until = performance.now() + budgetMs;
    while (this.cast < RAYS) {
      const { x, y } = rayPixel(this.cast++, ctx.frame);
      const d = depthUnder(p, ctx, x, y);
      if (d !== null && d > 0 && (this.seen === null || d < this.seen)) this.seen = d;
      if (performance.now() >= until) break;
    }
    if (this.cast >= RAYS) return true;
    if (this.paced()) this.gaveUp = this.late(this.cast / this.frames, leftNow);
    return false;
  }

  /** Rays a frame, once all are in or the pace so far counts, else 0. */
  pace(): number {
    return this.cast >= RAYS || this.paced() ? this.cast / this.frames : 0;
  }

  /** One slow ray can be a hitch rather than the model, so the pace counts from a second frame, or from the first when
   *  the model was slow before it changed. */
  private paced(): boolean {
    return this.frames > 1 || (this.frames === 1 && this.wasSlow);
  }

  private late(pace: number, framesLeft: () => number): boolean {
    return RAYS - this.cast > framesLeft() * pace;
  }

  nearest(): number | null {
    return this.seen;
  }
}

/** The nearest depth in the frustum of the parts whose box the eye is outside of, NaN for none, as nothing of theirs can
 *  be nearer, and whether a box holds the eye, which bounds nothing. */
export function partsFloor(p: Pose, aspect: number, parts: readonly THREE.Box3[]): { floor: number; inside: boolean } {
  eyeOf(p, eye);
  const inside = parts.some((b) => b.containsPoint(eye));
  const outside = inside ? parts.filter((b) => !b.containsPoint(eye)) : parts;
  return { floor: visibleNearDepth(p, aspect, outside), inside };
}

/** The depth to answer to. Rays can pass between thin parts, so they are only trusted to within `RAY_TRUST`, and only
 *  inside a box, where `floor` cannot speak for that part. A thin part of it further inside still moves only its depth
 *  ratio over `RAY_TRUST` times the threshold. */
export function nearestBound(seen: number | null, floor: number, inside: boolean, anchorDepth: number): number | null {
  if (Number.isNaN(floor) && !inside) return seen;
  const known = seen === null ? anchorDepth : Math.min(seen, anchorDepth);
  return Math.min(known, inside ? known / RAY_TRUST : known, Number.isNaN(floor) ? known : floor);
}

/** The log left that shifts nothing in view by more than `ZOOM_SNAP_PX`. */
export function zoomSnapLog(p: Pose, frame: Frame, anchor: THREE.Vector3, nearest: number | null): number {
  const at = project(p, frame, anchor);
  const reach = Math.hypot(Math.max(at.x, frame.width - at.x), Math.max(at.y, frame.height - at.y));
  const log = ZOOM_SNAP_PX / Math.max(reach, 1);
  if (p.ortho || nearest === null) return log;
  return log / Math.max(1, depthOf(p, anchor) / nearest);
}
