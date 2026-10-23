// Each transform holds its named point exactly on every call, so an eased gesture
// keeps that point on its pixel on every frame, not only at the end.

import * as THREE from "three";
import { turntableQuat } from "./math";
import { eyeOf, forwardOf, halfTan, rightOf, setOrientation, setTurntable, upOf, type Pose } from "./pose";

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion();

export function scaleAbout(p: Pose, a: THREE.Vector3, f: number) {
  p.target.sub(a).multiplyScalar(f).add(a);
  p.scale *= f;
}

/** Moves the target to `depth` along the view axis without changing the image. Perspective
 *  keeps the eye, orthographic moves the eye with the target. */
export function reseat(p: Pose, depth: number) {
  if (!(depth > 0) && !p.ortho) return;
  const fwd = forwardOf(p, v0);
  if (p.ortho) {
    const eye = eyeOf(p, v1);
    p.target.copy(eye).addScaledVector(fwd, depth);
    return;
  }
  const eye = eyeOf(p, v1);
  p.target.copy(eye).addScaledVector(fwd, depth);
  p.scale = depth * halfTan(p.fov);
}

export function rotateAbout(p: Pose, pivot: THREE.Vector3, qNew: THREE.Quaternion) {
  const r = q0.copy(qNew).multiply(q1.copy(p.q).invert());
  p.target.sub(pivot).applyQuaternion(r).add(pivot);
  p.q.copy(qNew);
}

/** Yaw steps are about world Z and elevation steps about camera right, Rz(dyaw)·q·Rx(delev),
 *  which commute, so any slicing of a drag lands on the same pose. */
export function turntableAbout(p: Pose, pivot: THREE.Vector3, yaw: number, elev: number, roll: number): void {
  const q = turntableQuat(yaw, elev, q1.clone());
  if (roll !== 0) q.multiply(q0.setFromAxisAngle(v0.set(0, 0, 1), roll));
  rotateAbout(p, pivot, q);
  if (roll === 0) setTurntable(p, yaw, elev);
  else p.level = false;
}

/** For the 3D mouse. */
export function rotateWorldAbout(p: Pose, pivot: THREE.Vector3, r: THREE.Quaternion) {
  const q = q1.copy(r).multiply(p.q).normalize();
  rotateAbout(p, pivot, q.clone());
  setOrientation(p, p.q);
}

/** (dx, dy) are world units along the camera's right and up. */
export function truck(p: Pose, dx: number, dy: number) {
  p.target.addScaledVector(rightOf(p, v0), dx).addScaledVector(upOf(p, v1), dy);
}
