// Each face's triangles in small spatial clusters with a local bounding box, so a box drag tests the clusters and
// walks only the triangles of those its edges cut. Projecting every vertex when a drag began froze the first frames
// of the box on a big mesh (2M triangles, several hundred ms). Built after the model paints, in idle slices.
import type * as THREE from "three";
import type { BodyMesh } from "./render";

/** Most CAD faces fit in one cluster, so a small model keeps one box per face as before. */
export const CLUSTER_TRIS = 128;

export interface BodyAreaIndex {
  geometry: THREE.BufferGeometry;
  posVersion: number;
  indexVersion: number;
  /** The face lists it was built from, in faceTriangles order, kept to tell when they change. */
  faceTris: number[][];
  /** Face k owns clusters firstCluster[k] up to firstCluster[k + 1]. */
  firstCluster: Uint32Array;
  /** Offset of each cluster in its face's sequence, which runs to the next cluster's offset or the sequence end. */
  clusterStart: Uint32Array;
  /** Local space min x, y, z then max x, y, z, six per cluster. */
  clusterBox: Float64Array;
  /** Each cluster's normal cone in local space, axis x, y, z then the cosine of its half angle, which is -2 when the
   *  cluster has a sliver or a spread too wide for the cone to say anything. */
  clusterCone: Float64Array;
  /** A big face's triangles grouped by cluster; a face of one cluster uses its faceTriangles list as is. */
  order: (Uint32Array | undefined)[];
}

/** The most grid cells a face's counting sort may use, 1 MB of counts. */
export const MAX_CELLS = 1 << 18;

/** Counters a test reads to prove where the work went. */
export const areaIndexStats = { idleBuilds: 0, syncBuilds: 0 };

const built = new WeakMap<BodyMesh, BodyAreaIndex>();
const pending = new Map<BodyMesh, Generator<void, BodyAreaIndex | null> | null>();
let scheduled = false;

/** Positions as a flat xyz array without a getter call per read; a strided or normalized buffer is copied once. */
function flatPositions(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): ArrayLike<number> {
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

function versionOf(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  return (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (a as THREE.InterleavedBufferAttribute).data.version
    : (a as THREE.BufferAttribute).version;
}

function* build(body: BodyMesh): Generator<void, BodyAreaIndex | null> {
  const geometry = body.mesh.geometry;
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!pos || !index) return null;
  // Read before the first yield, so a build paused across a geometry update records the versions it indexed.
  const posVersion = versionOf(pos);
  const indexVersion = index.version;
  const P = flatPositions(pos);
  const I = index.array;
  const faceTris = [...body.faceTriangles.values()];
  const firstCluster = new Uint32Array(faceTris.length + 1);
  const starts: number[] = [];
  const boxes: number[] = [];
  const cones: number[] = [];
  const order: (Uint32Array | undefined)[] = new Array(faceTris.length);
  let work = 0;

  const boxOver = (seq: ArrayLike<number>, from: number, to: number) => {
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let s = from; s < to; s++) {
      const t = seq[s] as number;
      for (let k = 0; k < 3; k++) {
        const v = (I[t * 3 + k] as number) * 3;
        const x = P[v] as number,
          y = P[v + 1] as number,
          z = P[v + 2] as number;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
    }
    boxes.push(x0, y0, z0, x1, y1, z1);
    coneOver(seq, from, to);
  };

  const nrm = [0, 0, 0];
  // False for a sliver, whose normal a world space recomputation could turn around.
  const normalOf = (t: number): boolean => {
    const a = (I[t * 3] as number) * 3,
      b = (I[t * 3 + 1] as number) * 3,
      c = (I[t * 3 + 2] as number) * 3;
    const abx = (P[b] as number) - (P[a] as number),
      aby = (P[b + 1] as number) - (P[a + 1] as number),
      abz = (P[b + 2] as number) - (P[a + 2] as number);
    const acx = (P[c] as number) - (P[a] as number),
      acy = (P[c + 1] as number) - (P[a + 1] as number),
      acz = (P[c + 2] as number) - (P[a + 2] as number);
    const nx = aby * acz - abz * acy,
      ny = abz * acx - abx * acz,
      nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-7 * Math.hypot(abx, aby, abz) * Math.hypot(acx, acy, acz))) return false;
    nrm[0] = nx / len;
    nrm[1] = ny / len;
    nrm[2] = nz / len;
    return true;
  };
  const coneOver = (seq: ArrayLike<number>, from: number, to: number) => {
    let ux = 0,
      uy = 0,
      uz = 0;
    for (let s = from; s < to; s++) {
      if (!normalOf(seq[s] as number)) {
        cones.push(0, 0, 0, -2);
        return;
      }
      ux += nrm[0]!;
      uy += nrm[1]!;
      uz += nrm[2]!;
    }
    const ul = Math.hypot(ux, uy, uz);
    if (!(ul > 1e-9)) {
      cones.push(0, 0, 0, -2);
      return;
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    let cos = 1;
    for (let s = from; s < to; s++) {
      normalOf(seq[s] as number);
      cos = Math.min(cos, ux * nrm[0]! + uy * nrm[1]! + uz * nrm[2]!);
    }
    cones.push(ux, uy, uz, cos > 0 ? cos : -2);
  };

  for (let f = 0; f < faceTris.length; f++) {
    firstCluster[f] = starts.length;
    const tris = faceTris[f] as number[];
    const n = tris.length;
    if (n <= CLUSTER_TRIS) {
      starts.push(0);
      boxOver(tris, 0, n);
      if ((work += n) > 16384) {
        work = 0;
        yield;
      }
      continue;
    }

    // A counting sort of the triangles by the grid cell of their centroid, the grid sized to about one cluster a cell.
    let cx0 = Infinity,
      cy0 = Infinity,
      cz0 = Infinity,
      cx1 = -Infinity,
      cy1 = -Infinity,
      cz1 = -Infinity;
    const cent = (t: number, axis: number) =>
      ((P[(I[t * 3] as number) * 3 + axis] as number) +
        (P[(I[t * 3 + 1] as number) * 3 + axis] as number) +
        (P[(I[t * 3 + 2] as number) * 3 + axis] as number)) /
      3;
    for (let s = 0; s < n; s++) {
      const t = tris[s] as number;
      const x = cent(t, 0),
        y = cent(t, 1),
        z = cent(t, 2);
      if (x < cx0) cx0 = x;
      if (y < cy0) cy0 = y;
      if (z < cz0) cz0 = z;
      if (x > cx1) cx1 = x;
      if (y > cy1) cy1 = y;
      if (z > cz1) cz1 = z;
      if (++work > 16384) {
        work = 0;
        yield;
      }
    }
    const big = Math.max(cx1 - cx0, cy1 - cy0, cz1 - cz0, 1e-9);
    const ex = Math.max(cx1 - cx0, big * 1e-3),
      ey = Math.max(cy1 - cy0, big * 1e-3),
      ez = Math.max(cz1 - cz0, big * 1e-3);
    let cell = Math.cbrt((ex * ey * ez) / Math.max(1, n / CLUSTER_TRIS));
    let gx = 1,
      gy = 1,
      gz = 1;
    // Coarser cells until the counts fit MAX_CELLS, a flat face would otherwise ask for a huge grid.
    for (;;) {
      gx = Math.max(1, Math.ceil(ex / cell));
      gy = Math.max(1, Math.ceil(ey / cell));
      gz = Math.max(1, Math.ceil(ez / cell));
      if (gx * gy * gz <= MAX_CELLS) break;
      cell *= 1.25;
    }
    const cellOf = new Uint32Array(n);
    const counts = new Uint32Array(gx * gy * gz + 1);
    for (let s = 0; s < n; s++) {
      const t = tris[s] as number;
      const ix = Math.min(gx - 1, Math.floor(((cent(t, 0) - cx0) / ex) * gx));
      const iy = Math.min(gy - 1, Math.floor(((cent(t, 1) - cy0) / ey) * gy));
      const iz = Math.min(gz - 1, Math.floor(((cent(t, 2) - cz0) / ez) * gz));
      const c = (iz * gy + iy) * gx + ix;
      cellOf[s] = c;
      counts[c + 1]!++;
      if (++work > 16384) {
        work = 0;
        yield;
      }
    }
    for (let c = 1; c < counts.length; c++) counts[c] = (counts[c] as number) + (counts[c - 1] as number);
    const seq = new Uint32Array(n);
    const fill = counts.slice(0, counts.length - 1);
    for (let s = 0; s < n; s++) {
      seq[fill[cellOf[s] as number]!++] = tris[s] as number;
      if (++work > 16384) {
        work = 0;
        yield;
      }
    }
    for (let c = 0; c + 1 < counts.length; c++) {
      const a = counts[c] as number,
        b = counts[c + 1] as number;
      for (let s = a; s < b; s += CLUSTER_TRIS) {
        const e = Math.min(b, s + CLUSTER_TRIS);
        starts.push(s);
        boxOver(seq, s, e);
        if ((work += e - s) > 16384) {
          work = 0;
          yield;
        }
      }
    }
    order[f] = seq;
  }
  firstCluster[faceTris.length] = starts.length;
  return {
    geometry,
    posVersion,
    indexVersion,
    faceTris,
    firstCluster,
    clusterStart: Uint32Array.from(starts),
    clusterBox: Float64Array.from(boxes),
    clusterCone: Float64Array.from(cones),
    order,
  };
}

function fresh(body: BodyMesh, idx: BodyAreaIndex | undefined): idx is BodyAreaIndex {
  if (!idx) return false;
  const geo = body.mesh.geometry;
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  if (idx.geometry !== geo || !pos || !index || versionOf(pos) !== idx.posVersion || index.version !== idx.indexVersion)
    return false;
  if (body.faceTriangles.size !== idx.faceTris.length) return false;
  let k = 0;
  for (const tris of body.faceTriangles.values()) if (tris !== idx.faceTris[k++]) return false;
  return true;
}

/** The body's index, built now if the idle queue has not reached it yet. */
export function areaIndexOf(body: BodyMesh): BodyAreaIndex | null {
  const have = built.get(body);
  if (fresh(body, have)) return have;
  const started = pending.get(body) ?? null;
  pending.delete(body);
  areaIndexStats.syncBuilds++;
  let r = finish(started ?? build(body));
  // An idle build begun before the geometry changed answers for triangles that are gone.
  if (started && r && !fresh(body, r)) r = finish(build(body));
  if (r) built.set(body, r);
  else built.delete(body);
  return r;
}

function finish(it: Generator<void, BodyAreaIndex | null>): BodyAreaIndex | null {
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** True once the body's index is built and still matches its geometry. */
export function areaIndexReady(body: BodyMesh): boolean {
  return fresh(body, built.get(body));
}

/** Builds queued indexes until `hasTime` says stop, checked before each body and between slices of a big one. The
 *  first slice always runs, so a forced callback with no time left still moves the queue on. A hidden body leaves
 *  the queue and is built when it is shown, or by the drag that needs it. Exported for tests. */
export function drainAreaIndex(hasTime: () => boolean) {
  scheduled = false;
  let first = true;
  for (const [body, started] of pending) {
    if (!body.mesh.visible) {
      pending.delete(body);
      continue;
    }
    if (!first && !hasTime()) break;
    first = false;
    const it = started ?? build(body);
    let r = it.next();
    while (!r.done && hasTime()) r = it.next();
    if (!r.done) {
      pending.set(body, it);
      break;
    }
    pending.delete(body);
    areaIndexStats.idleBuilds++;
    if (r.value) built.set(body, r.value);
  }
  if (pending.size) schedule();
}

function schedule() {
  if (scheduled || !pending.size) return;
  scheduled = true;
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback((d) => drainAreaIndex(() => d.timeRemaining() > 1), { timeout: 1000 });
    return;
  }
  setTimeout(() => {
    const t0 = performance.now();
    drainAreaIndex(() => performance.now() - t0 < 8);
  }, 0);
}

/** Queue a visible body's index for idle time, after the frame that shows it. */
export function scheduleAreaIndex(body: BodyMesh) {
  if (!body.mesh.visible || fresh(body, built.get(body))) return;
  pending.set(body, null);
  schedule();
}

/** A body that left the view needs no index. */
export function forgetAreaIndex(body: BodyMesh) {
  pending.delete(body);
  built.delete(body);
}
