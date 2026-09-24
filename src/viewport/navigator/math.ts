// Small exact pieces the navigator is built from: the turntable orientation,
// its decomposition, and a critically damped spring.
//
// Orientation convention: three.js cameras look down their local -Z with local
// +Y up. The level (turntable) orientations are q = Rz(yaw)·Rx(elev): elev 0
// looks straight down with +Y up on screen (Top, exactly), elev π/2 looks
// horizontally along +Y rotated by yaw, elev π looks straight up. Pitch, as the
// user sees it, is elev - 90°. Camera right is Rz(yaw)·X, so it never leaves the
// XY plane and the horizon cannot roll.

import * as THREE from "three";

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();

export function turntableQuat(yaw: number, elev: number, out = new THREE.Quaternion()): THREE.Quaternion {
  qa.setFromAxisAngle(Z, yaw);
  qb.setFromAxisAngle(X, elev);
  return out.multiplyQuaternions(qa, qb);
}

export interface Turntable {
  yaw: number;
  elev: number;
  /** Bank about the view axis that separates `q` from its level twin. */
  roll: number;
}

/** The level orientation looking the same way as `q`, and the roll between
 *  them: q = turntableQuat(yaw, elev)·Rz(roll). At the poles, where any yaw
 *  looks the same way, the yaw is taken from the camera's own right vector so
 *  the roll comes out 0 and the picture does not turn. */
export function decompose(q: THREE.Quaternion, out: Turntable = { yaw: 0, elev: 0, roll: 0 }): Turntable {
  const fwd = va.set(0, 0, -1).applyQuaternion(q);
  const elev = Math.acos(Math.max(-1, Math.min(1, -fwd.z)));
  let yaw: number;
  if (Math.sin(elev) > 1e-9) {
    // fwd × Z is the level right vector (cos yaw, sin yaw, 0) scaled by sin elev.
    yaw = Math.atan2(-fwd.x, fwd.y);
  } else {
    const right = vb.set(1, 0, 0).applyQuaternion(q);
    if (Math.hypot(right.x, right.y) > 1e-9) yaw = Math.atan2(right.y, right.x);
    else {
      const up = vb.set(0, 1, 0).applyQuaternion(q);
      yaw = Math.atan2(-up.x, up.y);
    }
  }
  turntableQuat(yaw, elev, qa).invert().multiply(q);
  const roll = 2 * Math.atan2(qa.z, qa.w);
  out.yaw = yaw;
  out.elev = elev;
  out.roll = wrapAngle(roll);
  return out;
}

/** Into (-π, π]. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** A critically damped spring on one number, integrated exactly, so the path
 *  it takes does not depend on how time is sliced into frames. `tau` is the
 *  smooth time: about how long it takes to cover most of the way (the same
 *  meaning as camera-controls' smoothTime). tau 0 lands at once. */
export class Spring {
  x = 0;
  v = 0;

  step(target: number, tau: number, dt: number): number {
    if (!(tau > 0) || !(dt > 0) || !Number.isFinite(dt)) {
      if (!(tau > 0)) {
        this.x = target;
        this.v = 0;
      }
      return this.x;
    }
    const w = 2 / tau;
    const y = this.x - target;
    const k = this.v + w * y;
    const e = Math.exp(-w * dt);
    this.x = target + (y + k * dt) * e;
    this.v = (this.v - w * k * dt) * e;
    return this.x;
  }

  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
}

/** Smootherstep: zero velocity at both ends, over at a time we choose. */
export function easeInOut(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function finiteVec(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function finiteQuat(q: THREE.Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}
