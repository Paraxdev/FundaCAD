// camera-controls rotates about its target, which a pan or an ortho zoom moves off the model. Shifting camera
// and target by (P-T) - q(P-T) after each update turns that into a rotation about P, which keeps P on its pixel.

import * as THREE from "three";

/** Taken from camera-controls' position and target, not the camera, so the view roll applied after
 *  every update (cameras.ts) is not measured as rotation. Null when the camera sits on its target. */
export function viewQuaternion(
  position: THREE.Vector3,
  target: THREE.Vector3,
  up: THREE.Vector3,
): THREE.Quaternion | null {
  if (position.distanceToSquared(target) < 1e-18) return null;
  const m = new THREE.Matrix4().lookAt(position, target, up);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function frameRotation(before: THREE.Quaternion, after: THREE.Quaternion): THREE.Quaternion {
  return after.clone().multiply(before.clone().invert());
}

/** Add it to BOTH the camera position and the target. `target` must be the one from before the
 *  frame: the post rotation target gives a shift off by exactly what the target already moved. */
export function pivotShift(q: THREE.Quaternion, pivot: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const v = pivot.clone().sub(target);
  return v.clone().sub(v.applyQuaternion(q));
}

/** Rings of `step` px outward from the cursor, clipped to the rect, nearest first, so the pivot
 *  is the model surface closest to where the drag began. */
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
