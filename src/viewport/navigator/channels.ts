// Eased gestures. Each channel eases an amount toward what the input asked for
// and hands back, every frame, an increment the navigator applies as an exact
// transform about the channel's own fixed centre.

import * as THREE from "three";
import { Spring } from "./math";

// A channel snaps to its goal once what is left is a ten-thousandth of a pixel
// or so; the snap is the same exact transform, so nothing it pins moves.
const EPS_LOG = 1e-7;
const EPS_ANGLE = 1e-6;
const EPS_PX = 1e-3;

/** Wheel or pinch zoom about one anchor, in log scale units. */
export class ZoomChannel {
  readonly anchor: THREE.Vector3;
  /** The pixel the anchor was taken under; a wheel at the same pixel keeps
   *  feeding this channel, since the anchor is still exactly under it. */
  readonly px: number;
  readonly py: number;
  goal = 0;
  private spring = new Spring();

  constructor(anchor: THREE.Vector3, px: number, py: number) {
    this.anchor = anchor.clone();
    this.px = px;
    this.py = py;
  }

  add(logFactor: number) {
    if (Number.isFinite(logFactor)) this.goal += logFactor;
  }

  /** The log factor to apply this frame. */
  step(tau: number, dt: number): number {
    const before = this.spring.x;
    this.spring.step(this.goal, tau, dt);
    if (Math.abs(this.goal - this.spring.x) < EPS_LOG && Math.abs(this.spring.v) < EPS_LOG * 100) {
      this.spring.reset(this.goal);
    }
    return this.spring.x - before;
  }

  /** A limit took less than was asked: forget the rest. */
  stopAt(appliedLog: number, requestedLog: number) {
    const lost = requestedLog - appliedLog;
    this.spring.x -= lost;
    this.goal = this.spring.x;
    this.spring.v = 0;
  }

  settled(): boolean {
    return this.goal === this.spring.x && this.spring.v === 0;
  }
}

/** Turntable orbit about a pivot, in absolute (yaw, elev, roll), so the eased
 *  and the raw drag end on the same pose whatever the frame slicing. */
export class OrbitChannel {
  readonly pivot: THREE.Vector3;
  goalYaw: number;
  goalElev: number;
  goalRoll: number;
  readonly roll0: number;
  /** Pixels dragged so far, which retire the roll a 3D mouse left. */
  travelled = 0;
  private yaw = new Spring();
  private elev = new Spring();
  private roll = new Spring();

  constructor(pivot: THREE.Vector3, yaw: number, elev: number, roll: number) {
    this.pivot = pivot.clone();
    this.goalYaw = yaw;
    this.goalElev = elev;
    this.goalRoll = roll;
    this.roll0 = roll;
    this.yaw.reset(yaw);
    this.elev.reset(elev);
    this.roll.reset(roll);
  }

  step(tau: number, dt: number): { yaw: number; elev: number; roll: number } {
    const settle = (s: Spring, goal: number) => {
      s.step(goal, tau, dt);
      if (Math.abs(goal - s.x) < EPS_ANGLE && Math.abs(s.v) < EPS_ANGLE * 100) s.reset(goal);
      return s.x;
    };
    return {
      yaw: settle(this.yaw, this.goalYaw),
      elev: settle(this.elev, this.goalElev),
      roll: settle(this.roll, this.goalRoll),
    };
  }

  settled(): boolean {
    return this.yaw.x === this.goalYaw && this.elev.x === this.goalElev && this.roll.x === this.goalRoll
      && this.yaw.v === 0 && this.elev.v === 0 && this.roll.v === 0;
  }

  /** The eased angles are what is on screen; make them the goal too. */
  freeze() {
    this.goalYaw = this.yaw.x;
    this.goalElev = this.elev.x;
    this.goalRoll = this.roll.x;
    this.yaw.v = this.elev.v = this.roll.v = 0;
  }
}

/** A grab: world point G is eased onto the cursor pixel. The error is measured
 *  from the pose on screen every frame, so whatever else moved the view (a
 *  wheel mid-pan), the pan still ends with G exactly under the cursor. */
export class PanChannel {
  readonly grab: THREE.Vector3;
  cx: number;
  cy: number;
  private sx = new Spring();
  private sy = new Spring();

  constructor(grab: THREE.Vector3, cx: number, cy: number) {
    this.grab = grab.clone();
    this.cx = cx;
    this.cy = cy;
  }

  /** Given G's pixel on screen now, the pixel shift to give it this frame. */
  step(gx: number, gy: number, tau: number, dt: number): [number, number] {
    const ex = this.cx - gx;
    const ey = this.cy - gy;
    this.sx.x = -ex;
    this.sy.x = -ey;
    this.sx.step(0, tau, dt);
    this.sy.step(0, tau, dt);
    let mx = ex + this.sx.x;
    let my = ey + this.sy.x;
    if (Math.abs(this.sx.x) < EPS_PX && Math.abs(this.sy.x) < EPS_PX
      && Math.abs(this.sx.v) < EPS_PX * 100 && Math.abs(this.sy.v) < EPS_PX * 100) {
      mx = ex;
      my = ey;
      this.sx.reset();
      this.sy.reset();
    }
    return [mx, my];
  }

  settled(gx: number, gy: number): boolean {
    return Math.abs(this.cx - gx) < 1e-6 && Math.abs(this.cy - gy) < 1e-6 && this.sx.v === 0 && this.sy.v === 0;
  }
}
