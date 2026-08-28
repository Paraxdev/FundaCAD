// The arithmetic behind turning bodies with a gizmo, kept away from the camera
// and the scene graph so vitest can check it.
//
// Two things here are worth stating rather than inlining.
//
// A ROTATION ABOUT A PIVOT is not something the `move` feature has. The kernel
// applies `Rot(rx, ry, rz)` about the WORLD origin and only then translates, so
// a body 300mm out along the part that you turn 90 degrees does not spin where
// it stands — it swings a quarter circle around the origin and lands somewhere
// else entirely. The fix is not a new feature: rotating about c and then moving
// by t is exactly rotating about the origin and moving by (t + c - R·c), which
// is a translation the feature can already carry. `composeMove` is that one
// line, written down once, because getting it wrong produces a body in a
// plausible-looking wrong place rather than an error.
//
// The EULER ORDER is the kernel's, not a preference. Rot(rx, ry, rz) composes as
// Rx · Ry · Rz — measured against build123d rather than assumed — which is what
// three.js calls "XYZ". Reading the angles back out in any other order gives a
// preview that agrees with the rebuild for a single-axis turn and diverges as
// soon as two axes are used, which is the worst way for it to be wrong.

import * as THREE from "three";

/** How far a rotation drag steps by default, in degrees. Fifteen because the
 *  turns people actually mean are its multiples — 15, 30, 45, 90 — and holding
 *  shift lifts it, the same way it lifts the translation step. */
export const ROTATE_SNAP_DEG = 15;

/** A basis for the plane a rotation happens in: two unit vectors perpendicular
 *  to `axis` and to each other, with u x v pointing ALONG the axis, so a
 *  positive angle is a right-handed turn about it. */
export interface RotationFrame {
  u: THREE.Vector3;
  v: THREE.Vector3;
}

export function rotationFrame(axis: THREE.Vector3): RotationFrame {
  const n = axis.clone().normalize();
  // Any vector not parallel to the axis will do; picking the world axis the
  // rotation axis is LEAST aligned with keeps the cross product well
  // conditioned, which matters because this runs on the world axes themselves.
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const u = ref.clone().sub(n.clone().multiplyScalar(ref.dot(n))).normalize();
  const v = n.clone().cross(u); // unit: n ⟂ u, both unit
  return { u, v };
}

/** Where a world point sits, as an angle about the pivot, in that frame.
 *  Radians, right-handed about the frame's axis. */
export function angleInFrame(
  point: THREE.Vector3,
  pivot: THREE.Vector3,
  frame: RotationFrame,
): number {
  const rel = point.clone().sub(pivot);
  return Math.atan2(rel.dot(frame.v), rel.dot(frame.u));
}

/** The shortest way round from one angle to another, in radians.
 *
 *  Without this a drag that crosses the ±pi seam reports a turn of nearly a full
 *  circle in the wrong direction — once per revolution, which is exactly often
 *  enough to be dismissed as a glitch and never fixed. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Round a rotation to the nearest step. `step <= 0` means no stepping. */
export function snapDegrees(deg: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(deg)) return deg;
  return Math.round(deg / step) * step;
}

export interface MoveValues {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
}

/** The six numbers a `move` feature needs to turn a selection about `pivot` by
 *  `rot` and then shift it by `translate`.
 *
 *  Angles come out in degrees in the kernel's own order (see the header). The
 *  translation carries the pivot correction, which is the whole reason this
 *  exists. */
export function composeMove(
  pivot: THREE.Vector3,
  rot: THREE.Quaternion,
  translate: THREE.Vector3,
): MoveValues {
  const e = new THREE.Euler().setFromQuaternion(rot, "XYZ");
  const spun = pivot.clone().applyQuaternion(rot);
  // The `+ 0` is not decoration: a zero rotation comes back out of the Euler
  // conversion as -0 on two of the three axes, and -0 is what would be written
  // into the document and shown in the value row.
  const deg = (r: number) => (r * 180) / Math.PI + 0;
  return {
    dx: translate.x + pivot.x - spun.x + 0,
    dy: translate.y + pivot.y - spun.y + 0,
    dz: translate.z + pivot.z - spun.z + 0,
    rx: deg(e.x),
    ry: deg(e.y),
    rz: deg(e.z),
  };
}

/** The same transform as a matrix, for the live preview.
 *
 *  Built from `composeMove`'s own output rather than from the pivot and the
 *  quaternion directly. That is the point: the preview and the feature are then
 *  provably the same transform, and a mistake in the composition shows up as a
 *  preview that is wrong in the same way the result will be, instead of a
 *  preview that looks right and a rebuild that jumps. */
export function moveMatrix(v: MoveValues): THREE.Matrix4 {
  const rad = (d: number) => (d * Math.PI) / 180;
  const m = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(rad(v.rx), rad(v.ry), rad(v.rz), "XYZ"),
  );
  m.premultiply(new THREE.Matrix4().makeTranslation(v.dx, v.dy, v.dz));
  return m;
}

/** Is this rotation axis too close to the line of sight to drag against?
 *
 *  Looking straight down a rotation axis is the GOOD case — the ring faces you
 *  and the cursor's angle about its centre is the turn. Looking along the
 *  ring's own plane is the bad one: the ring is a line on screen, the plane the
 *  cursor is intersected against is edge-on, and a pixel of mouse movement
 *  becomes an unbounded jump. `dot` is between the view direction and the axis;
 *  near zero means the axis is across the screen and the plane is edge-on. */
export function ringDragDegenerate(dot: number): boolean {
  return Math.abs(dot) < 0.12; // within ~7 degrees of edge-on
}
