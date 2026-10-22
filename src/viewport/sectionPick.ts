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
const probe = new THREE.Raycaster();
const box = new THREE.Box3();
const crossing = new THREE.Vector3();

// The cap's stencil count: +1 per face the ray leaves through, -1 per face it enters. Hits within `eps` of each other
// are one crossing per sign, as a ray through an edge hits both its triangles and a graze hits a front and a back.
function windingAlong(mesh: THREE.Object3D, eps: number): { w: number; first: THREE.Intersection | undefined } {
  const hits = probe.intersectObject(mesh, false);
  normalMatrix.getNormalMatrix(mesh.matrixWorld);
  let w = 0;
  let from = -Infinity;
  let signs = 0;
  for (const h of hits) {
    if (!h.face) continue;
    if (h.distance - from > eps) {
      from = h.distance;
      signs = 0;
    }
    const s = normal.copy(h.face.normal).applyNormalMatrix(normalMatrix).dot(probe.ray.direction) > 0 ? 1 : 2;
    if (signs & s) continue;
    signs |= s;
    w += s === 1 ? 1 : -1;
  }
  return { w, first: hits[0] };
}

// A body holds the point where the ray enters the kept half when its winding is the same non zero count ahead and
// behind; an open sheet or shell (a surface body, a broken mesh) has no inside and fails that, so it stays pickable.
function capHit(raycaster: THREE.Raycaster, first: THREE.Object3D, meshes: THREE.Object3D[], eps: number) {
  raycaster.ray.at(raycaster.near, crossing);
  probe.layers.mask = raycaster.layers.mask;
  for (const mesh of [first, ...meshes.filter((m) => m !== first)]) {
    const g = (mesh as THREE.Mesh).geometry;
    if (!g) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!box.copy(g.boundingBox!).applyMatrix4(mesh.matrixWorld).expandByScalar(eps).containsPoint(crossing)) continue;
    probe.ray.set(crossing, raycaster.ray.direction);
    const ahead = windingAlong(mesh, eps);
    if (!ahead.w || !ahead.first) continue;
    probe.ray.direction.negate();
    if (windingAlong(mesh, eps).w !== ahead.w) continue;
    return { ...ahead.first, distance: raycaster.near + ahead.first.distance };
  }
  return null;
}

export interface KeptHit {
  /** On the cap, the capped body's first hit past the cut, which may lie behind another body's face. */
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
  const cap = raycaster.near > 0 ? capHit(raycaster, hit.object, meshes, slack) : null;
  return cap ? { hit: cap, cap: true, distance: raycaster.near } : { hit, cap: false, distance: hit.distance };
}
