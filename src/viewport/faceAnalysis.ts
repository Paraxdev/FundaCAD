// What the press pull handle and the selection readout need of the selected faces. Releasing a box that took one
// face of a 3.5M triangle mesh froze the page for 9 to 23 s: three listeners each asked for it, and each answer
// walked the face several times with a THREE.Triangle per triangle. It is now worked out once per selection, and the
// shape fits look at an even sample of a dense face.
import * as THREE from "three";
import { bodyOfFace, type BodyMesh, type ModelView } from "./render";
import { areaIndexOf, CLUSTER_TRIS } from "./areaIndex";
import {
  arcSweep,
  cylinderFromFace,
  FULL_SWEEP,
  isPlanarFace,
  onRoundFace,
  roundStand,
  solidInsideCylinder,
  sphereCentreFromFace,
  unit,
  type Cylinder,
} from "../features/planeMath";
import { facetNormalAt, type RoundFace } from "../features/radialDrag";
import type { Selector, Vec3 } from "../types";

/** Whole face walks and the triangles they visit, for tests. */
export const faceWalks = { count: 0, triangles: 0 };

/** The shape fits take at most this many triangles of a face, evenly strided. A CAD face is far below it, so its
 *  answer is unchanged; a dense mesh face gets a fit from a sample, which the engine's exact answer replaces. */
export const FIT_TRIS = 20_000;

export interface PressPullFaces {
  selectors: Selector[];
  faceIds: number[];
  normal: THREE.Vector3;
  anchor: THREE.Vector3;
  bodyId: string | null;
  round: RoundFace | null;
  lead: RoundFace | null;
}

export interface RoundFit {
  cylinder: Cylinder;
  solidInside: boolean;
  points: Vec3[];
  full: boolean;
}

/** About `max` triangles of a dense face as whole spatial patches, the box selection index's clusters, picked one
 *  from each of equal runs at a hashed spot. An even every Nth triangle aliased with a mesh tessellated in rings
 *  and took one generator line, and lone triangles have no inner corner, which the sphere fit asks for. */
function samplePatches(body: BodyMesh, tris: number[], max: number): number[] {
  const idx = areaIndexOf(body);
  const f = idx ? idx.faceTris.indexOf(tris) : -1;
  const out: number[] = [];
  if (!idx || f < 0) {
    const run = tris.length / max;
    for (let k = 0; k < max; k++) {
      const from = Math.floor(k * run);
      out.push(tris[from + (sampleHash(k) % Math.max(1, Math.floor((k + 1) * run) - from))]!);
    }
    return out;
  }
  const seq = idx.order[f] ?? tris;
  const first = idx.firstCluster[f]!;
  const count = idx.firstCluster[f + 1]! - first;
  const want = Math.min(count, Math.max(1, Math.ceil(max / CLUSTER_TRIS)));
  const run = count / want;
  for (let k = 0; k < want; k++) {
    const from = Math.floor(k * run);
    const c = first + from + (sampleHash(k) % Math.max(1, Math.floor((k + 1) * run) - from));
    const end = c + 1 < first + count ? idx.clusterStart[c + 1]! : seq.length;
    for (let s = idx.clusterStart[c]!; s < end; s++) out.push(seq[s]!);
  }
  return out;
}

/** A fixed integer hash, so the same face always gives the same sample. */
function sampleHash(k: number): number {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The face's triangles in world space; with more than `max`, a sample of whole patches (samplePatches). */
export function faceTrianglesOf(model: ModelView | null, faceId: number, max = Infinity): THREE.Triangle[] {
  const out: THREE.Triangle[] = [];
  const body = model && bodyOfFace(model, faceId);
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris) return out;
  faceWalks.count++;
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex()!;
  const mw = body.mesh.matrixWorld;
  const take = (t: number) =>
    out.push(
      new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw),
      ),
    );
  if (tris.length <= max) {
    faceWalks.triangles += tris.length;
    for (const t of tris) take(t);
    return out;
  }
  const picked = samplePatches(body, tris, max);
  faceWalks.triangles += picked.length;
  for (const t of picked) take(t);
  return out;
}

// A face's centre, normal and plane, kept until its body's geometry, pose or triangle list changes, so the
// listeners and panels that ask about one selection share one walk.
interface FaceFacts {
  key: string;
  tris: number[];
  centroid?: THREE.Vector3;
  normal?: THREE.Vector3;
  plane?: { tol: number; value: { normal: THREE.Vector3; origin: THREE.Vector3 } | null };
}
const facts = new WeakMap<BodyMesh, Map<number, FaceFacts>>();

function factsOf(model: ModelView | null, faceId: number): FaceFacts | null {
  const body = model && bodyOfFace(model, faceId);
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris) return null;
  const geo = body.mesh.geometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
  const key = `${geo.id}|${pos?.version ?? -1}|${body.mesh.matrixWorld.elements.join()}`;
  let byFace = facts.get(body);
  if (!byFace) facts.set(body, (byFace = new Map()));
  let f = byFace.get(faceId);
  if (!f || f.key !== key || f.tris !== tris) byFace.set(faceId, (f = { key, tris }));
  return f;
}

/** A point on a face: the vertex mean snapped to the nearest triangle centroid. The
 *  mean alone lands on a cylinder's axis, where by:"nearest" finds the inner wall. */
export function faceCentroidOf(model: ModelView | null, faceId: number): THREE.Vector3 {
  const f = factsOf(model, faceId);
  if (!f) return new THREE.Vector3();
  f.centroid ??= walkCentroid(model, faceId);
  return f.centroid.clone();
}

/** Exact for a planar face, a representative outward direction for a curved one. */
export function faceNormalOf(model: ModelView | null, faceId: number): THREE.Vector3 {
  const f = factsOf(model, faceId);
  if (!f) return new THREE.Vector3(0, 0, 1);
  f.normal ??= walkNormal(model, faceId);
  return f.normal.clone();
}

/** The face's plane when every vertex lies within `tol` of the plane through its centre, else null. Stops at the
 *  first vertex off it, so a curved mesh face costs a few triangles. */
export function planeOfFace(
  model: ModelView | null,
  faceId: number,
  tol: number,
): { normal: THREE.Vector3; origin: THREE.Vector3 } | null {
  const f = factsOf(model, faceId);
  if (!f || f.tris.length === 0) return null;
  if (!f.plane || f.plane.tol !== tol) {
    const n = faceNormalOf(model, faceId);
    const c = faceCentroidOf(model, faceId);
    const d0 = n.dot(c);
    const body = bodyOfFace(model!, faceId)!;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const mw = body.mesh.matrixWorld;
    const v = new THREE.Vector3();
    let flat = true;
    for (let s = 0; s < f.tris.length && flat; s++) {
      const t = f.tris[s]!;
      faceWalks.triangles++;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, index.getX(t * 3 + k)).applyMatrix4(mw);
        if (Math.abs(n.dot(v) - d0) > tol) {
          flat = false;
          break;
        }
      }
    }
    f.plane = { tol, value: flat ? { normal: n, origin: c } : null };
  }
  const p = f.plane.value;
  return p && { normal: p.normal.clone(), origin: p.origin.clone() };
}

function walkCentroid(model: ModelView | null, faceId: number): THREE.Vector3 {
  const acc = new THREE.Vector3();
  const body = model && bodyOfFace(model, faceId);
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris) return acc;
  faceWalks.count++;
  faceWalks.triangles += tris.length;
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex()!;
  const P = xyzOf(pos);
  const I = index.array;
  // A mark per vertex: a Set of a few million entries was most of a dense face's cost. Plain sums in the order
  // Vector3.add made them, so the point is the same to the last bit.
  const seen = new Uint8Array(pos.count);
  let count = 0;
  let ax = 0,
    ay = 0,
    az = 0;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = I[t * 3 + k]!;
      if (seen[vi]) continue;
      seen[vi] = 1;
      count++;
      ax += P[vi * 3]!;
      ay += P[vi * 3 + 1]!;
      az += P[vi * 3 + 2]!;
    }
  }
  acc.set(ax, ay, az);
  if (count) acc.divideScalar(count);
  const third = 1 / 3;
  const best = new THREE.Vector3();
  let bestD = Infinity;
  for (const t of tris) {
    const a = I[t * 3]! * 3,
      b = I[t * 3 + 1]! * 3,
      c = I[t * 3 + 2]! * 3;
    const cx = (0 + P[a]! + P[b]! + P[c]!) * third;
    const cy = (0 + P[a + 1]! + P[b + 1]! + P[c + 1]!) * third;
    const cz = (0 + P[a + 2]! + P[b + 2]! + P[c + 2]!) * third;
    const dx = cx - acc.x,
      dy = cy - acc.y,
      dz = cz - acc.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best.set(cx, cy, cz);
    }
  }
  if (bestD < Infinity) acc.copy(best);
  return acc.applyMatrix4(body.mesh.matrixWorld);
}

function walkNormal(model: ModelView | null, faceId: number): THREE.Vector3 {
  const acc = new THREE.Vector3();
  const body = model && bodyOfFace(model, faceId);
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris) {
    acc.set(0, 0, 1);
    return acc;
  }
  faceWalks.count++;
  faceWalks.triangles += tris.length;
  const P = xyzOf(body.mesh.geometry.getAttribute("position"));
  const I = body.mesh.geometry.getIndex()!.array;
  let nx = 0,
    ny = 0,
    nz = 0;
  for (const t of tris) {
    const a = I[t * 3]! * 3,
      b = I[t * 3 + 1]! * 3,
      c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!,
      uy = P[b + 1]! - P[a + 1]!,
      uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!,
      vy = P[c + 1]! - P[a + 1]!,
      vz = P[c + 2]! - P[a + 2]!;
    // Twice the triangle's area long, so the sum is area weighted.
    nx += uy * vz - uz * vy;
    ny += uz * vx - ux * vz;
    nz += ux * vy - uy * vx;
  }
  acc.set(nx, ny, nz);
  if (acc.lengthSq() < 1e-12) acc.set(0, 0, 1);
  return acc.normalize().transformDirection(body.mesh.matrixWorld).normalize();
}

/** Positions as flat xyz without a getter call per read; a strided or normalized buffer is copied. */
function xyzOf(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): ArrayLike<number> {
  const plain = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized;
  if (plain && pos.itemSize === 3) return (pos as THREE.BufferAttribute).array;
  const out = new Float64Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  return out;
}

/** The cylinder a face lies on, from a sample of a dense face. */
export function roundFitOf(model: ModelView | null, faceId: number, tris?: THREE.Triangle[]): RoundFit | null {
  const sample = tris ?? faceTrianglesOf(model, faceId, FIT_TRIS);
  if (sample.length < 3) return null;
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const n = new THREE.Vector3();
  for (const t of sample) {
    points.push([t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]);
    t.getNormal(n);
    normals.push([n.x, n.y, n.z]);
  }
  const cylinder = cylinderFromFace(points, normals);
  if (!cylinder) return null;
  const solidInside = solidInsideCylinder(cylinder, points, normals);
  if (solidInside === null) return null;
  return { cylinder, solidInside, points, full: arcSweep(cylinder, points) > FULL_SWEEP };
}

export function roundFrom(fit: { cylinder: Cylinder; solidInside: boolean; full: boolean }, radial: Vec3): RoundFace {
  return {
    cylinder: fit.cylinder,
    radius: fit.cylinder.radius,
    solidInside: fit.solidInside,
    radial: new THREE.Vector3(radial[0], radial[1], radial[2]),
    full: fit.full,
    tangent: null,
  };
}

/** Where the last plain click hit, when that point lies on this round face. */
export function clickOnRound(fit: { cylinder: Cylinder; points: Vec3[] }, click: Vec3 | null): Vec3 | null {
  if (!click) return null;
  return onRoundFace(fit.cylinder, fit.points, click, Math.max(0.05 * fit.cylinder.radius, 1e-3)) ? click : null;
}

/** The selected faces' selectors, the handle's anchor and direction, and the round face under it. */
export function pressPullOf(
  model: ModelView,
  faces: readonly number[],
  click: Vec3 | null,
  fitTris = FIT_TRIS,
): PressPullFaces | null {
  const first = faces[0];
  if (first === undefined) return null;
  const centres = faces.map((fid) => faceCentroidOf(model, fid));
  const selectors: Selector[] = centres.map((c) => ({ kind: "face", by: "nearest", point: [c.x, c.y, c.z] }));
  let anchor = centres[0]!.clone();
  let normal = faceNormalOf(model, first);
  let round: RoundFace | null = null;
  const tris = faceTrianglesOf(model, first, fitTris);
  const fit = roundFitOf(model, first, tris);
  const stand =
    fit && roundStand(fit.cylinder, fit.points, fit.full, clickOnRound(fit, click), [anchor.x, anchor.y, anchor.z]);
  if (fit && stand) {
    anchor = new THREE.Vector3(...stand.point);
    round = roundFrom(fit, stand.radial);
    normal = round.radial.clone().multiplyScalar(round.solidInside ? 1 : -1);
  } else {
    const normals = tris.map((t) => t.getNormal(new THREE.Vector3()).toArray() as Vec3);
    // A sphere, cone or torus: the normal where the handle stands, as the tool uses, never the average,
    // which on a closed face points along its axis or nowhere.
    const curved = !isPlanarFace(normals);
    // A sphere resizes about its centre, so its handle points out from there
    // on a dimple too, where the face's own normal points in.
    const centre = curved
      ? sphereCentreFromFace(
          tris.flatMap((t) => [t.a.toArray(), t.b.toArray(), t.c.toArray()] as Vec3[]),
          normals,
        )
      : null;
    const out = centre && unit([anchor.x - centre[0], anchor.y - centre[1], anchor.z - centre[2]]);
    const at = out ? new THREE.Vector3(...out) : curved ? facetNormalAt(tris, anchor) : null;
    if (at) normal = at;
  }
  return {
    selectors,
    faceIds: [...faces],
    normal,
    anchor,
    bodyId: bodyOfFace(model, first)?.id ?? null,
    // A multi-face press/pull shares a single distance along a single normal;
    // a diameter is a property of one face and has no meaning spread across several.
    round: faces.length === 1 ? round : null,
    lead: faces.length > 1 ? round : null,
  };
}

function cloneRound(r: RoundFace | null): RoundFace | null {
  return r && { ...r, radial: r.radial.clone(), ...(r.centre ? { centre: [...r.centre] as Vec3 } : {}) };
}

function clonePressPull(p: PressPullFaces): PressPullFaces {
  return {
    selectors: p.selectors.map((s) => ({ ...s, point: [...(s as { point: Vec3 }).point] }) as Selector),
    faceIds: [...p.faceIds],
    normal: p.normal.clone(),
    anchor: p.anchor.clone(),
    bodyId: p.bodyId,
    round: cloneRound(p.round),
    lead: cloneRound(p.lead),
  };
}

/** The last answer, kept while the model, the selection, the last click and the bodies' poses and geometry stay the
 *  same, so the listeners of one selection change share one walk. Each caller gets its own copy to change. */
export class PressPullMemo {
  // Per model and weakly, so a model that left the view is not kept by its last answer.
  private last = new WeakMap<ModelView, { key: string; value: PressPullFaces | null }>();

  get(model: ModelView, faces: readonly number[], click: Vec3 | null): PressPullFaces | null {
    const key = memoKey(model, faces, click);
    let hit = this.last.get(model);
    if (!hit || hit.key !== key) {
      hit = { key, value: pressPullOf(model, faces, click) };
      this.last.set(model, hit);
    }
    return hit.value && clonePressPull(hit.value);
  }
}

// A face's triangle list by identity: a kept body whose face ids shift in place hands an id a different list.
const listIds = new WeakMap<number[], number>();
let nextListId = 0;
function listId(tris: number[] | undefined): number {
  if (!tris) return -1;
  let id = listIds.get(tris);
  if (id === undefined) listIds.set(tris, (id = ++nextListId));
  return id;
}

function memoKey(model: ModelView, faces: readonly number[], click: Vec3 | null): string {
  const parts = [faces.join(), click ? click.join() : "-"];
  const seen = new Set<string>();
  for (const f of faces) {
    const b = bodyOfFace(model, f);
    parts.push(String(listId(b?.faceTriangles.get(f))));
    if (!b || seen.has(b.id)) continue;
    seen.add(b.id);
    const geo = b.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    parts.push(
      b.id,
      String(b.faceStart),
      String(geo.id),
      String(pos?.version ?? -1),
      b.mesh.matrixWorld.elements.join(),
    );
  }
  return parts.join("|");
}
