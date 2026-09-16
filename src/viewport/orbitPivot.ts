// Orbiting about a point that is not the orbit target.
//
// camera-controls always aims the camera AT its target, so the point it rotates
// about is necessarily the one at the centre of the screen. That is the right
// pivot only while the target still coincides with what is being looked at, and
// two ordinary gestures move it away: a pan translates camera and target
// together, and orthographic zoom-to-cursor trucks both toward the cursor. Once
// the target sits well off the model, orbiting swings the model through an arc
// whose radius is that whole offset, and it leaves the frame. Measured on a
// 40x30x20 box: a pan of 380px put the target 61mm from a model of radius 27mm,
// and a 160px orbit then took the model half off the top of the screen.
//
// The fix does not fight the library. Rotating rigidly about a point P leaves P
// exactly where it was on screen, because P is fixed by the rotation and the
// whole camera frame turns with it. And a rotation about T followed by a rigid
// TRANSLATION is a rotation about some other point: for every X,
//
//     [P + q(X-P)] - [T + q(X-T)]  =  (P-T) - q(P-T)
//
// which does not depend on X. So the library rotates about its target as it
// always has, and the same constant shift applied to the camera and the target
// afterwards turns that into a rotation about P, with no change to the
// orientation the library computed and nothing to unwind if the pivot is
// dropped mid-drag.

import * as THREE from "three";

/** The camera basis camera-controls itself is expressing, taken from its own
 *  position/target rather than from the camera object, so a persistent view roll
 *  (applied after every update, see cameras.ts) does not appear in the rotation
 *  measured between two frames. Null when the camera sits on its target, where
 *  there is no view direction to speak of. */
export function viewQuaternion(
  position: THREE.Vector3,
  target: THREE.Vector3,
  up: THREE.Vector3,
): THREE.Quaternion | null {
  if (position.distanceToSquared(target) < 1e-18) return null;
  const m = new THREE.Matrix4().lookAt(position, target, up);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** The rotation that took the camera from one frame's basis to the next. */
export function frameRotation(before: THREE.Quaternion, after: THREE.Quaternion): THREE.Quaternion {
  return after.clone().multiply(before.clone().invert());
}

/** The rigid translation that turns `q` applied about `target` into `q` applied
 *  about `pivot`. Add it to BOTH the camera position and the target: translating
 *  only one of them would re-aim the camera, which is a rotation, not a shift.
 *
 *  `target` is the target the rotation was applied about, i.e. the one from
 *  BEFORE the frame. Passing the post-rotation target instead gives a shift that
 *  is wrong by exactly the amount the target already moved. */
export function pivotShift(
  q: THREE.Quaternion,
  pivot: THREE.Vector3,
  target: THREE.Vector3,
): THREE.Vector3 {
  const v = pivot.clone().sub(target);
  return v.clone().sub(v.applyQuaternion(q));
}

/** Screen points to try for an orbit pivot when the press missed the model, in
 *  rings of `step` px outward from the cursor, clipped to the rect. Nearest ring
 *  first, so the pivot is the model surface closest to where the drag began. */
export function pivotProbes(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
  step = 24,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const reach = Math.hypot(Math.max(x - rect.left, rect.right - x), Math.max(y - rect.top, rect.bottom - y));
  for (let r = step; r <= reach; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom) out.push({ x: px, y: py });
    }
  }
  return out;
}
