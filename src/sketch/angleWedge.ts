// The wedge an angle dimension shows: two rays out of the lines' crossing, one along
// each line, and the counterclockwise angle from the first ray to the second.

import type { AngleRay } from "../types";
import { lineIntersect, signedAngleDeg } from "./geom2d";
import * as THREE from "three";

type V = THREE.Vector2;
type Seg = { x1: number; y1: number; x2: number; y2: number };

export interface Wedge {
  /** true when l2's ray starts the counterclockwise sweep, so the constraint stores l2 first */
  swap: boolean;
  rays: [AngleRay, AngleRay];
  /** degrees, counterclockwise from the first ray to the second, in (0, 360) */
  value: number;
}

const unit = (s: Seg): V => new THREE.Vector2(s.x2 - s.x1, s.y2 - s.y1).normalize();
const ccwDeg = (a: V, b: V): number => {
  const d = (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
};

/** where the two infinite lines cross, null when they are parallel */
export function crossingOf(s1: Seg, s2: Seg): V | null {
  return lineIntersect(
    new THREE.Vector2(s1.x1, s1.y1), new THREE.Vector2(s1.x2, s1.y2),
    new THREE.Vector2(s2.x1, s2.y1), new THREE.Vector2(s2.x2, s2.y2),
  );
}

/** The wedge holding `cursor`: of the four wedges the two lines cut, the one the cursor
 *  sits in, or its 360 complement when `reflex`. */
export function wedgeAt(s1: Seg, s2: Seg, cursor: V, reflex = false): Wedge | null {
  const x = crossingOf(s1, s2);
  if (!x) return null;
  const d1 = unit(s1), d2 = unit(s2);
  const c = cursor.clone().sub(x);
  if (c.lengthSq() < 1e-18) c.copy(d1).add(d2);
  const r1: AngleRay = c.dot(d1) >= 0 ? 1 : -1;
  const r2: AngleRay = c.dot(d2) >= 0 ? 1 : -1;
  const u1 = d1.clone().multiplyScalar(r1), u2 = d2.clone().multiplyScalar(r2);
  // the cursor is inside the acute or obtuse wedge between u1 and u2; order the rays so
  // that wedge runs counterclockwise from the first to the second
  const fromU1 = ccwDeg(u1, u2);
  let swap = fromU1 > 180;
  let value = swap ? 360 - fromU1 : fromU1;
  if (reflex) { swap = !swap; value = 360 - value; }
  return { swap, rays: swap ? [r2, r1] : [r1, r2], value };
}

/** The signed angle, degrees in (-180, 180], from l1's direction to l2's that an angle
 *  dim means, the form the solver takes. */
export function solverAngleDeg(value: number, rays?: [AngleRay, AngleRay]): number {
  let d = rays && rays[0] !== rays[1] ? value + 180 : value;
  d = ((d % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/** what an angle dim reads for the lines as they are now */
export function measuredAngleDeg(s1: Seg, s2: Seg, rays?: [AngleRay, AngleRay]): number {
  if (!rays) return signedAngleDeg(s1, s2);
  return ccwDeg(unit(s1).multiplyScalar(rays[0]), unit(s2).multiplyScalar(rays[1]));
}

/** The rays a dim shows, as unit vectors out of the crossing. A dim without `rays`
 *  shows the sweep its signed angle makes. */
export function wedgeRays(s1: Seg, s2: Seg, rays?: [AngleRay, AngleRay]): { from: V; sweepDeg: number } {
  if (rays) return { from: unit(s1).multiplyScalar(rays[0]), sweepDeg: measuredAngleDeg(s1, s2, rays) };
  const a = signedAngleDeg(s1, s2);
  return a >= 0
    ? { from: unit(s1), sweepDeg: a }
    : { from: unit(s2), sweepDeg: -a };
}
