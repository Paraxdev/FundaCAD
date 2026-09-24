// Exact transforms of a pose. Each one names the point it holds still, and holds
// it still exactly, on every call, so an eased gesture made of many small calls
// keeps that point on its pixel on every frame rather than only at the end.

import * as THREE from "three";
import { turntableQuat } from "./math";
import {
  eyeOf, forwardOf, halfTan, rightOf, setOrientation, setTurntable, upOf,
  type Pose,
} from "./pose";

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion();

/** Scale the view by `f` about world point A: A keeps its pixel, in either
 *  projection, and nothing turns. */
export function scaleAbout(p: Pose, a: THREE.Vector3, f: number) {
  p.target.sub(a).multiplyScalar(f).add(a);
  p.scale *= f;
}

/** Slide the target along the view axis to `depth` in front of the eye, without
 *  changing anything on screen. Perspective keeps the eye where it is, so the
 *  half height at the new depth changes; orthographic keeps the half height,
 *  and the eye, which it does not see through, moves with the target. */
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

/** Turn the whole camera rigidly about P to a new orientation. P keeps its
 *  pixel, because its position in the camera's frame is unchanged. */
export function rotateAbout(p: Pose, pivot: THREE.Vector3, qNew: THREE.Quaternion) {
  const r = q0.copy(qNew).multiply(q1.copy(p.q).invert());
  p.target.sub(pivot).applyQuaternion(r).add(pivot);
  p.q.copy(qNew);
}

/** Turn about P to the turntable orientation (yaw, elev), banked by `roll` about
 *  the view axis (0 for a level view). Yaw steps are about world Z and
 *  elevation steps about camera right, Rz(dyaw)·q·Rx(delev), which commute, so
 *  any slicing of a drag lands on the same pose. */
export function turntableAbout(
  p: Pose,
  pivot: THREE.Vector3,
  yaw: number,
  elev: number,
  roll: number,
): void {
  const q = turntableQuat(yaw, elev, q1.clone());
  if (roll !== 0) q.multiply(q0.setFromAxisAngle(v0.set(0, 0, 1), roll));
  rotateAbout(p, pivot, q);
  if (roll === 0) setTurntable(p, yaw, elev);
  else p.level = false;
}

/** Free rotation about P by a world rotation (3D mouse). */
export function rotateWorldAbout(p: Pose, pivot: THREE.Vector3, r: THREE.Quaternion) {
  const q = q1.copy(r).multiply(p.q).normalize();
  rotateAbout(p, pivot, q.clone());
  setOrientation(p, p.q);
}

/** Move camera and target together by (dx, dy) in world units along the
 *  camera's right and up. */
export function truck(p: Pose, dx: number, dy: number) {
  p.target.addScaledVector(rightOf(p, v0), dx).addScaledVector(upOf(p, v1), dy);
}
