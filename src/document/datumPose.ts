// Where a datum plane sits relative to its reference, the frontend twin of the
// engine's features/datum.rs `place`. The two must agree to the last digit or the
// quad drawn here and the sketches the engine builds on it part company.
//
// Reference frame (u, v, n), shifted by shiftX/shiftY/offset along those axes,
// then turned about that point: tiltX about u, tiltY about the v that leaves,
// spin about the n that leaves. Each turn is about an axis the later ones leave
// alone, so a handle can drag one angle while the others hold still.

import * as THREE from "three";
import type { Feature, PlaneDef, PlaneSpec } from "../types";
import { SketchPlane } from "../sketch/plane";

export interface DatumPose {
  offset: number;
  shiftX: number;
  shiftY: number;
  tiltX: number;
  tiltY: number;
  spin: number;
}

export const POSE_FIELDS = ["offset", "shiftX", "shiftY", "tiltX", "tiltY", "spin"] as const;
export type PoseField = (typeof POSE_FIELDS)[number];

export const ZERO_POSE: DatumPose = { offset: 0, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, spin: 0 };

type DatumFeature = Extract<Feature, { type: "datumPlane" }>;

export function poseOf(f: DatumFeature): DatumPose {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    offset: n(f.offset),
    shiftX: n(f.shiftX),
    shiftY: n(f.shiftY),
    tiltX: n(f.tiltX),
    tiltY: n(f.tiltY),
    spin: n(f.spin),
  };
}

const RAD = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** The turn in the reference's own coordinates, Rx(tiltX) · Ry(tiltY) · Rz(spin). */
export function localTurn(p: Pick<DatumPose, "tiltX" | "tiltY" | "spin">): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(p.tiltX * RAD, p.tiltY * RAD, p.spin * RAD, "XYZ"));
}

function basis(src: SketchPlane): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(src.u, src.v, src.n);
}

/** Components within a rounding error of a whole number are that number, as the
 *  engine does, so a quarter turn reads as an exact axis. */
function clean(v: THREE.Vector3): [number, number, number] {
  const c = (a: number) => {
    const r = Math.round(a);
    return (Math.abs(a - r) < 1e-12 ? r : a) + 0;
  };
  return [c(v.x), c(v.y), c(v.z)];
}

export function pivotOf(src: PlaneSpec, p: DatumPose): THREE.Vector3 {
  const s = new SketchPlane(src);
  return s.origin.clone()
    .addScaledVector(s.u, p.shiftX)
    .addScaledVector(s.v, p.shiftY)
    .addScaledVector(s.n, p.offset);
}

export function placeDatum(src: PlaneSpec, p: DatumPose): PlaneDef {
  const s = new SketchPlane(src);
  const o = pivotOf(src, p);
  if (p.tiltX === 0 && p.tiltY === 0 && p.spin === 0) {
    return { origin: [o.x, o.y, o.z], normal: [s.n.x, s.n.y, s.n.z], xdir: [s.u.x, s.u.y, s.u.z] };
  }
  const world = basis(s).multiply(new THREE.Matrix4().makeRotationFromQuaternion(localTurn(p)));
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  world.extractBasis(x, y, z);
  return { origin: [o.x, o.y, o.z], normal: clean(z), xdir: clean(x) };
}

/** The reference a placed plane was made from, given the pose it was placed with. */
export function sourceOfPlaced(placed: PlaneDef, p: DatumPose): PlaneDef {
  const s = new SketchPlane(placed);
  const turn = new THREE.Matrix4().makeRotationFromQuaternion(localTurn(p));
  const ref = new THREE.Matrix4().makeBasis(s.u, s.v, s.n).multiply(turn.transpose());
  const u = new THREE.Vector3(), v = new THREE.Vector3(), n = new THREE.Vector3();
  ref.extractBasis(u, v, n);
  const o = s.origin.clone().addScaledVector(u, -p.shiftX).addScaledVector(v, -p.shiftY).addScaledVector(n, -p.offset);
  return { origin: [o.x, o.y, o.z], normal: [n.x, n.y, n.z], xdir: [u.x, u.y, u.z] };
}

/** The pose that puts a plane at `target` from `src`: the inverse of placeDatum,
 *  used when something moves the plane as a whole (the Move gizmo). */
export function poseFromPlaced(src: PlaneSpec, target: PlaneDef): DatumPose {
  const s = new SketchPlane(src);
  const t = new SketchPlane(target);
  const rel = basis(s).transpose().multiply(new THREE.Matrix4().makeBasis(t.u, t.v, t.n));
  const e = new THREE.Euler().setFromRotationMatrix(rel, "XYZ");
  const d = t.origin.clone().sub(s.origin);
  const tidy = (a: number) => Math.round(a * 1e6) / 1e6 + 0;
  return {
    offset: tidy(d.dot(s.n)),
    shiftX: tidy(d.dot(s.u)),
    shiftY: tidy(d.dot(s.v)),
    tiltX: tidy(e.x / RAD),
    tiltY: tidy(e.y / RAD),
    spin: tidy(e.z / RAD),
  };
}

/** The world axes the three turns act about, for a pose already applied: tiltX
 *  about the reference u, tiltY about u turned by tiltX, spin about the normal
 *  both tilts leave. Dragging one of them is a turn about that fixed axis. */
export function turnAxes(src: PlaneSpec, p: DatumPose): { tiltX: THREE.Vector3; tiltY: THREE.Vector3; spin: THREE.Vector3 } {
  const s = new SketchPlane(src);
  const b = basis(s);
  const qx = new THREE.Quaternion().setFromAxisAngle(X, p.tiltX * RAD);
  const qxy = qx.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y, p.tiltY * RAD));
  return {
    tiltX: s.u.clone(),
    tiltY: Y.clone().applyQuaternion(qx).transformDirection(b),
    spin: new THREE.Vector3(0, 0, 1).applyQuaternion(qxy).transformDirection(b),
  };
}

/** The fields a pose writes: zero is left out, so an untouched plane keeps the
 *  shape an older build reads the same way. */
export function poseFields(p: DatumPose): Partial<DatumPose> {
  const out: Partial<DatumPose> = {};
  for (const k of POSE_FIELDS) if (p[k] !== 0) out[k] = p[k];
  return out;
}
