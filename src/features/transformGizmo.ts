// Gizmo transform math, kept off the camera and scene graph so vitest can check it.

import * as THREE from "three";

/** Degrees: the turns people mean are multiples of 15, and shift lifts it like the translation step. */
export const ROTATE_SNAP_DEG = 15;

/** Unit vectors perpendicular to the axis and each other, u x v along the axis, so a positive angle
 *  is a right-handed turn about it. */
export interface RotationFrame {
  u: THREE.Vector3;
  v: THREE.Vector3;
}

export function rotationFrame(axis: THREE.Vector3): RotationFrame {
  const n = axis.clone().normalize();
  // The world axis least aligned with the rotation axis keeps the cross product well conditioned,
  // which matters because this runs on the world axes themselves.
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const u = ref
    .clone()
    .sub(n.clone().multiplyScalar(ref.dot(n)))
    .normalize();
  const v = n.clone().cross(u);
  return { u, v };
}

/** Radians, right-handed about the frame's axis. */
export function angleInFrame(point: THREE.Vector3, pivot: THREE.Vector3, frame: RotationFrame): number {
  const rel = point.clone().sub(pivot);
  return Math.atan2(rel.dot(frame.v), rel.dot(frame.u));
}

/** Shortest way round, in radians, or a drag across the ±pi seam reports a near full turn the wrong way. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

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

/** The kernel's `move` rotates about the world origin and then translates, so a turn about `pivot` is
 *  carried as translate + pivot - R·pivot; getting it wrong lands the body in a plausible wrong place.
 *  "XYZ" is the kernel's Rx·Ry·Rz, measured against build123d; another order diverges on two axis turns. */
export function composeMove(pivot: THREE.Vector3, rot: THREE.Quaternion, translate: THREE.Vector3): MoveValues {
  const e = new THREE.Euler().setFromQuaternion(rot, "XYZ");
  const spun = pivot.clone().applyQuaternion(rot);
  // `+ 0` turns the -0 a zero rotation comes back as into 0 before it reaches the document.
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

/** Built from composeMove's output, so the preview and the feature are provably the same transform. */
export function moveMatrix(v: MoveValues): THREE.Matrix4 {
  const rad = (d: number) => (d * Math.PI) / 180;
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rad(v.rx), rad(v.ry), rad(v.rz), "XYZ"));
  m.premultiply(new THREE.Matrix4().makeTranslation(v.dx, v.dy, v.dz));
  return m;
}

/** The gizmo applies T·R·scaleAbout, the order of a `scale` feature before a `move` in the timeline;
 *  any other order agrees with the rebuild only while one of them is the identity. */
export function scaleAbout(pivot: THREE.Vector3, s: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

/** Zero collapses the solid, which the kernel refuses, and negative is a mirror the preview's matrix
 *  decomposition cannot represent; a drag stops here instead of failing on commit. */
export const MIN_SCALE = 0.01;

/** `dot` is between the view direction and the axis. Near zero the ring's plane is edge-on and a pixel
 *  of mouse becomes an unbounded jump; 0.12 is within about 7 degrees of edge-on. */
export function ringDragDegenerate(dot: number): boolean {
  return Math.abs(dot) < 0.12;
}
