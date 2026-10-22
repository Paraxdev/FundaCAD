// Level camera orientations are q = Rz(yaw)·Rx(elev), the camera looking down local -Z: elev 0 is Top with +Y up, pi/2
// horizontal, pi straight up, pitch is elev - 90 deg. Camera right stays in XY, so the horizon cannot roll.

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

/** q = turntableQuat(yaw, elev)·Rz(roll). At the poles the yaw comes from the camera's own right vector, so the roll is
 *  0 and the picture does not turn. */
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

/** Critically damped and integrated exactly, so the path does not depend on frame slicing. `tau` is the smooth time,
 *  like camera-controls' smoothTime; 0 lands at once. */
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
