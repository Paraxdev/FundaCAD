// Picks under a section cut. three.js raycasts ignore clipping planes and a BVH returns only the first hit, so a body
// ray is limited to the stretch the cut keeps (Raycaster near and far) before it is cast.
import * as THREE from "three";

// A fraction of the model size: a point this far into the removed half still counts as kept, which covers float32
// vertex noise on a large part and keeps a face lying in the cut plane pickable.
export const SECTION_PICK_SLACK = 1e-5;

const PARALLEL = 1e-12;

export interface KeptSpan {
  near: number;
  far: number;
}

/** The distances along `ray` that `plane` keeps (three's clip rule: kept where distanceToPoint >= 0), null for none. */
export function keptSpan(ray: THREE.Ray, plane: THREE.Plane, slack: number): KeptSpan | null {
  const s0 = plane.distanceToPoint(ray.origin) + slack;
  const k = plane.normal.dot(ray.direction);
  if (Math.abs(k) < PARALLEL) return s0 >= 0 ? { near: 0, far: Infinity } : null;
  const t = -s0 / k;
  if (k > 0) return { near: Math.max(0, t), far: Infinity };
  return t >= 0 ? { near: 0, far: Math.max(0, t) } : null;
}

/** Limits `raycaster` to what `plane` keeps along its ray, or to the whole ray for null. False when nothing is kept. */
export function applyKeptSpan(raycaster: THREE.Raycaster, plane: THREE.Plane | null, slack: number): boolean {
  const span = plane ? keptSpan(raycaster.ray, plane, slack) : { near: 0, far: Infinity };
  raycaster.near = span ? span.near : Infinity;
  raycaster.far = span ? span.far : Infinity;
  return !!span;
}

export function keptPoint(point: THREE.Vector3, plane: THREE.Plane, slack: number): boolean {
  return plane.distanceToPoint(point) >= -slack;
}

const normal = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();

/** Whether `hit`, the first hit of a cast limited by applyKeptSpan, is a wall seen from inside: the ray entered the
 *  kept half through a body, where the section's cap is drawn over that wall. */
export function onCap(raycaster: THREE.Raycaster, hit: THREE.Intersection): boolean {
  if (!(raycaster.near > 0) || !hit.face) return false;
  normalMatrix.getNormalMatrix(hit.object.matrixWorld);
  return normal.copy(hit.face.normal).applyNormalMatrix(normalMatrix).dot(raycaster.ray.direction) > 0;
}

export interface KeptHit {
  hit: THREE.Intersection;
  /** On the cap there is no face to pick, only the body, and the surface is the cut plane at `distance`. */
  cap: boolean;
  distance: number;
}

/** The first hit on `meshes` that `plane` keeps along `raycaster`, null for none. Leaves the raycaster limited. */
export function firstKeptHit(
  raycaster: THREE.Raycaster,
  meshes: THREE.Object3D[],
  plane: THREE.Plane | null,
  slack: number,
): KeptHit | null {
  if (!applyKeptSpan(raycaster, plane, slack)) return null;
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const cap = onCap(raycaster, hit);
  return { hit, cap, distance: cap ? raycaster.near : hit.distance };
}
