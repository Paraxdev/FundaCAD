// Whole-pose flights: the ViewCube, fit, reset, standard views, sketch entry.
//
// The pose is interpolated as a pose (orientation, target, log of the scale,
// lens), never as an eye position, so the target stays on the view axis on
// every frame. Between two level orientations the turn goes through level ones
// (yaw and elevation interpolated), so a cube click never rolls the horizon on
// the way.

import * as THREE from "three";
import { easeInOut, wrapAngle } from "./math";
import { clonePose, copyPose, setTurntable, type Pose } from "./pose";
import { flightSeconds, worthFlying } from "../viewFlight";

export interface Flight {
  from: Pose;
  to: Pose;
  t: number;
  dur: number;
  /** A hard flight takes no input until it lands (sketch entry). */
  hard: boolean;
  onArrive: (() => void) | null;
}

/** Angle between two orientations, radians. */
export function turnBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
}

/** How long a flight between two poses should take, or 0 when it is not worth
 *  flying at all (the view is already there). */
export function flightDuration(a: Pose, b: Pose): number {
  const turn = turnBetween(a.q, b.q);
  const zoom = Math.max(a.scale / b.scale, b.scale / a.scale);
  const shift = a.target.distanceTo(b.target) / Math.max(1e-12, Math.min(a.scale, b.scale));
  const ratio = zoom * (1 + shift);
  const fov = Math.abs(a.fov - b.fov) > 1e-6;
  if (!worthFlying(turn, ratio) && !fov) return 0;
  return flightSeconds(turn, ratio);
}

export function makeFlight(from: Pose, to: Pose, hard: boolean, onArrive: (() => void) | null, dur?: number): Flight {
  return { from: clonePose(from), to: clonePose(to), t: 0, dur: dur ?? flightDuration(from, to), hard, onArrive };
}

/** The pose at eased fraction `u` of the way. */
export function flightPose(f: Flight, u: number, out: Pose): Pose {
  const a = f.from;
  const b = f.to;
  if (u >= 1) {
    const ortho = out.ortho;
    copyPose(out, b);
    out.ortho = ortho;
    return out;
  }
  out.target.lerpVectors(a.target, b.target, u);
  out.scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * u);
  out.fov = a.fov + (b.fov - a.fov) * u;
  if (a.level && b.level) {
    setTurntable(out, a.yaw + wrapAngle(b.yaw - a.yaw) * u, a.elev + (b.elev - a.elev) * u);
  } else {
    out.q.slerpQuaternions(a.q, b.q, u);
    out.level = false;
  }
  return out;
}

/** Advance; true once it has landed. */
export function stepFlight(f: Flight, dt: number, out: Pose): boolean {
  f.t += Math.max(0, dt);
  const done = !(f.dur > 0) || f.t >= f.dur;
  flightPose(f, done ? 1 : easeInOut(f.t / f.dur), out);
  return done;
}
