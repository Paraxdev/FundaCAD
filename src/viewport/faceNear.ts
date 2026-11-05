// The face nearest a point, visiting the box selection index's triangle clusters nearest box first and stopping once a
// box is farther than the best triangle so far. Scanning every triangle cost about 5 ms a call on a 110k triangle body.
import * as THREE from "three";
import { areaIndexOf, type BodyAreaIndex } from "./areaIndex";
import type { BodyMesh } from "./render";

/** Counters a test reads to prove how much of the mesh a lookup touched. */
export const faceNearStats = { triangles: 0 };

const target = new THREE.Vector3();
const local = new THREE.Vector3();
const inv = new THREE.Matrix4();
const tri = new THREE.Triangle();
const closest = new THREE.Vector3();

interface Best {
  face: number | null;
  dist: number;
  /** The face's place in the bodies' faceTriangles order, which settles a tie as the full scan's first strict less. */
  ord: number;
}

/** The face of `bodies` whose triangles come nearest `point`, if within `tol`. Distances are taken in each body's
 *  local space, ties go to the face first in body then faceTriangles order, as a scan of every triangle answers. */
export function nearestFaceId(
  bodies: readonly BodyMesh[],
  point: readonly [number, number, number],
  tol: number,
  onBody?: string,
): number | null {
  target.set(point[0], point[1], point[2]);
  const best: Best = { face: null, dist: Infinity, ord: Infinity };
  let ord = 0;
  for (const body of bodies) {
    const faces = body.faceTriangles.size;
    if (onBody === undefined || body.id === onBody) {
      inv.copy(body.mesh.matrixWorld).invert();
      local.copy(target).applyMatrix4(inv);
      const idx = areaIndexOf(body);
      if (idx) searchIndexed(body, idx, tol, ord, best);
      else scanAll(body, ord, best);
    }
    ord += faces;
  }
  return best.face != null && best.dist <= tol ? best.face : null;
}

function visit(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute,
  t: number,
  face: number,
  ord: number,
  best: Best,
) {
  tri.a.fromBufferAttribute(pos, index.getX(t * 3));
  tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
  tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
  tri.closestPointToPoint(local, closest);
  const d = closest.distanceTo(local);
  if (d < best.dist || (d === best.dist && ord < best.ord)) {
    best.dist = d;
    best.face = face;
    best.ord = ord;
  }
}

function scanAll(body: BodyMesh, ord: number, best: Best) {
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex()!;
  let k = ord;
  for (const [faceId, tris] of body.faceTriangles) {
    for (const t of tris) visit(pos, index, t, faceId, k, best);
    faceNearStats.triangles += tris.length;
    k++;
  }
}

function searchIndexed(body: BodyMesh, idx: BodyAreaIndex, tol: number, ord: number, best: Best) {
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex()!;
  const box = idx.box;
  // A closest point found in float arithmetic may sit a rounding step outside its triangle's box.
  let mag = 1;
  for (let k = 0; k < 6; k++) if (Number.isFinite(box[k]!)) mag = Math.max(mag, Math.abs(box[k]!));
  const pad = 1e-9 * mag;
  const bound = () => Math.min(best.dist, tol) + pad;

  const faceIds = [...body.faceTriangles.keys()];
  const nClusters = idx.clusterStart.length;
  const dist = new Float64Array(nClusters);
  const faceOf = new Uint32Array(nClusters);
  const cand: number[] = [];
  const cb = idx.clusterBox;
  const limit = bound();
  for (let f = 0; f < faceIds.length; f++) {
    for (let c = idx.firstCluster[f]!; c < idx.firstCluster[f + 1]!; c++) {
      const o = c * 6;
      const dx = Math.max(cb[o]! - local.x, 0, local.x - cb[o + 3]!);
      const dy = Math.max(cb[o + 1]! - local.y, 0, local.y - cb[o + 4]!);
      const dz = Math.max(cb[o + 2]! - local.z, 0, local.z - cb[o + 5]!);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > limit) continue;
      dist[c] = d;
      faceOf[c] = f;
      cand.push(c);
    }
  }
  cand.sort((a, b) => dist[a]! - dist[b]!);
  for (const c of cand) {
    if (dist[c]! > bound()) break;
    const f = faceOf[c]!;
    const seq = idx.order[f] ?? idx.faceTris[f]!;
    const end = c + 1 < idx.firstCluster[f + 1]! ? idx.clusterStart[c + 1]! : seq.length;
    for (let s = idx.clusterStart[c]!; s < end; s++) visit(pos, index, seq[s]!, faceIds[f]!, ord + f, best);
    faceNearStats.triangles += end - idx.clusterStart[c]!;
  }
}
