// Where a sketch lands on a face and how far the view may drift off it, pure tuples with no THREE.js so vitest can
// pin them down: a basis that spins moves every coordinate, an inward normal makes the first extrude cut.

import type { PlaneDef } from "../types";

export type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

const WORLD_AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** +Z, so a degenerate pick still gives a drawable sketch rather than NaNs. */
const FALLBACK_N: Vec3 = [0, 0, 1];

/** Escape hatch for reversed winding (an imported mesh): the caller opts in with a point it knows is inside the
 *  material, since a naive body-centre test gets overhang undersides backwards. null trusts the normal (face pick). */
export function outwardNormal(normal: Vec3, at: Vec3, inside: Vec3 | null): Vec3 {
  if (!inside) return normal;
  const out: Vec3 = [at[0] - inside[0], at[1] - inside[1], at[2] - inside[2]];
  if (dot(out, out) < 1e-18) return normal; // the point IS the reference: no "out"
  return dot(normal, out) < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
}

/** The world axis after the one the normal most nearly faces (X->Y->Z), with the normal projected out: +Z gets u=+X,
 *  +X gets u=+Y. Never reads the camera or click, or the sketch would rotate between openings on one face. That axis
 *  is never dominant, so |n·axis| <= 1/sqrt(2) and the projection cannot collapse. */
export function sketchXdir(normal: Vec3): Vec3 {
  const n = unit(normal) ?? FALLBACK_N;
  let dominant = 0;
  for (let i = 1; i < 3; i++) {
    if (Math.abs(n[i]!) > Math.abs(n[dominant]!)) dominant = i;
  }
  const axis = WORLD_AXES[(dominant + 1) % 3]!;
  const k = dot(n, axis);
  return unit([axis[0] - n[0] * k, axis[1] - n[1] * k, axis[2] - n[2] * k]) ?? [1, 0, 0];
}

/** The origin is the WORLD origin projected onto the face plane, not the centroid: grid snapping rounds in plane-local
 *  coordinates, and pickFacePlane, planeOffsetTool and the datum planes do the same, so all planes share one lattice. */
export function faceSketchPlane(normal: Vec3, point: Vec3, inside: Vec3 | null = null): PlaneDef {
  const n = outwardNormal(unit(normal) ?? FALLBACK_N, point, inside);
  const xdir = sketchXdir(n);
  const d = dot(n, point);
  return {
    origin: [n[0] * d, n[1] * d, n[2] * d],
    normal: [n[0], n[1], n[2]],
    xdir: [xdir[0], xdir[1], xdir[2]],
  };
}

/** v = n × u, exported so tests can check the basis is right-handed with the normal out. */
export function sketchYdir(plane: PlaneDef): Vec3 {
  return cross(plane.normal, plane.xdir);
}

/** Multiple of the entry framing past which the square-to-plane lock lets go: one deliberate scroll-out reaches it,
 *  the zoom nudges people make while drawing do not. */
export const VIEW_RELEASE_FACTOR = 2.2;

/** The lock is a function of zoom, not a mode: past the release factor it lets go for the rest of the session, since
 *  re-squaring under a user who took hold of the view is what feels rigid. Look At brings it back. */
export function sketchLockHolds(entryScale: number, scale: number): boolean {
  if (!(entryScale > 0) || !Number.isFinite(entryScale)) return true; // no baseline yet
  if (!(scale > 0) || !Number.isFinite(scale)) return true;
  return scale <= entryScale * VIEW_RELEASE_FACTOR;
}

/** Degrees. Wide enough that a fit or pan does not trip it, narrow enough that a deliberate orbit does at once. */
export const SQUARE_TOL_DEG = 8;

/** With Lock to Plane off, the flat projection follows the view rather than the mode. Sign-blind: the side is
 *  settled at entry (viewFlight.viewSideNormal), not every frame. */
export function viewSquareToPlane(viewDir: Vec3, normal: Vec3, tolDeg: number = SQUARE_TOL_DEG): boolean {
  const d = unit(viewDir);
  const n = unit(normal);
  if (!d || !n) return true; // nothing to measure: assume it still holds
  return Math.abs(dot(d, n)) >= Math.cos((tolDeg * Math.PI) / 180);
}
