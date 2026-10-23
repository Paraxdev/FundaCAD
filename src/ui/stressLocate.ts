// Finds where a point of the part's own surface lies on the engine's tet boundary, so the solver's corner fields can
// be read there with the boundary triangle's weights.

import type { Vec3 } from "../types";

export interface EngineSurface {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  faceIds?: ArrayLike<number> | undefined;
  vonMises: ArrayLike<number>;
  displacement?: ArrayLike<number> | undefined;
  /** Six per vertex, xx yy zz xy yz zx in MPa; older engines omit it. */
  stress?: ArrayLike<number> | undefined;
}

/** Von Mises at `weights` in engine triangle `tri`. Von Mises is not linear in the stress, so blending the corners'
 *  values dents it where a component changes sign (a beam's neutral line); the blended tensor does not. */
export function vonMisesAt(
  s: Pick<EngineSurface, "indices" | "vonMises" | "stress">,
  tri: number,
  weights: ArrayLike<number>,
): number {
  const ids = [s.indices[tri * 3]!, s.indices[tri * 3 + 1]!, s.indices[tri * 3 + 2]!];
  const t = s.stress;
  if (!t || t.length !== s.vonMises.length * 6) {
    let vm = 0;
    for (let k = 0; k < 3; k++) vm += weights[k]! * (s.vonMises[ids[k]!] ?? 0);
    return vm;
  }
  const c = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k++) for (let j = 0; j < 6; j++) c[j]! += weights[k]! * t[ids[k]! * 6 + j]!;
  const [xx, yy, zz, xy, yz, zx] = c as [number, number, number, number, number, number];
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy * xy + yz * yz + zx * zx));
}

export interface Located {
  tri: number;
  weights: Vec3;
  distance: number;
}

export interface Locator {
  /** The closest engine triangle on B-rep face `face` within FACE_REACH local edges, else the closest of any face;
   *  `face` -1 takes any. Null for an empty surface. */
  closest(p: Vec3, face: number): Located | null;
  /** The mean edge length of the engine triangle closest to `p`, 0 for an empty surface. */
  edgeAt(p: Vec3): number;
}

// The tet boundary rounds a sharp edge within about an element, so a point on one face of the edge often lies closer
// to the other face's triangles; four edges reach past that rounding without crossing a thin wall.
export const FACE_REACH = 4;

/** The closest point of triangle abc to p as barycentric weights of (a, b, c). */
export function closestWeights(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const w = new Float64Array(3);
  closestInto(w, p, [...a, ...b, ...c], 0);
  return [w[0]!, w[1]!, w[2]!];
}

// The triangle's corners are q[o..o + 9], x y z of a, b then c.
function closestInto(out: Float64Array, p: Vec3, q: ArrayLike<number>, o: number): void {
  const set = (x: number, y: number, z: number) => {
    out[0] = x;
    out[1] = y;
    out[2] = z;
  };
  const ax = q[o]!, ay = q[o + 1]!, az = q[o + 2]!;
  const bx = q[o + 3]!, by = q[o + 4]!, bz = q[o + 5]!;
  const cx = q[o + 6]!, cy = q[o + 7]!, cz = q[o + 8]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(1, 0, 0);
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(1 - v, v, 0);
  }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(1 - w, 0, w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(0, 1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  set(1 - v - w, v, w);
}

export function locator(s: EngineSurface): Locator {
  const tris = Math.floor(s.indices.length / 3);
  // Corners per triangle, x y z of a then b then c.
  const P = new Float64Array(tris * 9);
  const meanEdge = new Float64Array(tris);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const i = s.indices[t * 3 + k]! * 3;
      for (let j = 0; j < 3; j++) {
        const x = s.positions[i + j]!;
        P[t * 9 + k * 3 + j] = x;
        lo[j] = Math.min(lo[j]!, x);
        hi[j] = Math.max(hi[j]!, x);
      }
    }
    const o = t * 9;
    const e = (u: number, v: number) => Math.hypot(P[o + u]! - P[o + v]!, P[o + u + 1]! - P[o + v + 1]!, P[o + u + 2]! - P[o + v + 2]!);
    meanEdge[t] = (e(0, 3) + e(3, 6) + e(6, 0)) / 3;
    total += meanEdge[t]!;
  }
  const cell = tris ? Math.max((2 * total) / tris, 1e-9) : 1;
  const cellOf = (x: number, k: number) => Math.floor((x - lo[k]!) / cell);
  const dims = tris ? [0, 1, 2].map((k) => cellOf(hi[k]!, k) + 1) : [0, 0, 0];
  const [nx, ny, nz] = dims as [number, number, number];
  const cellIndex = (i: number, j: number, k: number) => (i * ny + j) * nz + k;
  // Triangles per cell, compressed: cell c holds items[start[c]] to items[start[c + 1]].
  const start = new Int32Array(nx * ny * nz + 1);
  const bounds = new Float64Array(tris * 6);
  const box = new Int32Array(tris * 6);
  for (let t = 0; t < tris; t++)
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k;
      bounds[t * 6 + k] = Math.min(P[o]!, P[o + 3]!, P[o + 6]!);
      bounds[t * 6 + 3 + k] = Math.max(P[o]!, P[o + 3]!, P[o + 6]!);
      box[t * 6 + k] = cellOf(bounds[t * 6 + k]!, k);
      box[t * 6 + 3 + k] = cellOf(bounds[t * 6 + 3 + k]!, k);
    }
  const each = (t: number, f: (c: number) => void) => {
    const b = t * 6;
    for (let i = box[b]!; i <= box[b + 3]!; i++)
      for (let j = box[b + 1]!; j <= box[b + 4]!; j++)
        for (let k = box[b + 2]!; k <= box[b + 5]!; k++) f(cellIndex(i, j, k));
  };
  for (let t = 0; t < tris; t++) each(t, (c) => start[c + 1]!++);
  for (let c = 0; c < nx * ny * nz; c++) start[c + 1]! += start[c]!;
  const items = new Int32Array(start[nx * ny * nz]!);
  const fill = start.slice(0, nx * ny * nz);
  for (let t = 0; t < tris; t++) each(t, (c) => (items[fill[c]!++] = t));
  const seen = new Int32Array(tris);
  let query = 0;
  const w = new Float64Array(3);

  function search(p: Vec3, face: number, reach: number): Located | null {
    if (!tris) return null;
    query++;
    const ids = s.faceIds;
    const c = [0, 1, 2].map((k) => cellOf(p[k]!, k));
    const beyond = Math.max(...c.map((x, k) => Math.max(-x, x - dims[k]! + 1, 0)));
    const span = Math.max(nx, ny, nz);
    let best: Located | null = null;
    for (let r = 0; r <= span + beyond + 1; r++) {
      // Every point within (r - 1) cells of p's cell has been covered once shell r - 1 is done.
      const covered = (r - 1) * cell;
      if (best && best.distance <= covered) break;
      if (covered > reach) break;
      const i0 = Math.max(c[0]! - r, 0), i1 = Math.min(c[0]! + r, nx - 1);
      const j0 = Math.max(c[1]! - r, 0), j1 = Math.min(c[1]! + r, ny - 1);
      const k0 = Math.max(c[2]! - r, 0), k1 = Math.min(c[2]! + r, nz - 1);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const edge = Math.abs(i - c[0]!) === r || Math.abs(j - c[1]!) === r;
          // Inside the shell's i and j only the two k faces lie on it.
          const step = edge ? 1 : Math.max(2 * r, 1);
          for (let k = edge ? k0 : c[2]! - r; k <= k1; k += step) {
            if (k < k0) continue;
            const cc = cellIndex(i, j, k);
            for (let n = start[cc]!; n < start[cc + 1]!; n++) {
              const t = items[n]!;
              if (seen[t] === query) continue;
              seen[t] = query;
              if (face >= 0 && ids?.[t] !== face) continue;
              const b = t * 6;
              const gx = Math.max(bounds[b]! - p[0], 0, p[0] - bounds[b + 3]!);
              const gy = Math.max(bounds[b + 1]! - p[1], 0, p[1] - bounds[b + 4]!);
              const gz = Math.max(bounds[b + 2]! - p[2], 0, p[2] - bounds[b + 5]!);
              const gap = Math.hypot(gx, gy, gz);
              if (gap > reach || (best && gap > best.distance)) continue;
              const o = t * 9;
              closestInto(w, p, P, o);
              const dx = p[0] - (w[0]! * P[o]! + w[1]! * P[o + 3]! + w[2]! * P[o + 6]!);
              const dy = p[1] - (w[0]! * P[o + 1]! + w[1]! * P[o + 4]! + w[2]! * P[o + 7]!);
              const dz = p[2] - (w[0]! * P[o + 2]! + w[1]! * P[o + 5]! + w[2]! * P[o + 8]!);
              const d = Math.hypot(dx, dy, dz);
              if (d <= reach && (!best || d < best.distance || (d === best.distance && t < best.tri)))
                best = { tri: t, weights: [w[0]!, w[1]!, w[2]!], distance: d };
            }
          }
        }
    }
    return best;
  }

  return {
    closest(p, face) {
      const near = search(p, -1, Infinity);
      const ids = s.faceIds;
      if (!near || face < 0 || !ids || ids[near.tri] === face) return near;
      return search(p, face, FACE_REACH * meanEdge[near.tri]!) ?? near;
    },
    edgeAt(p) {
      const near = search(p, -1, Infinity);
      return near ? meanEdge[near.tri]! : 0;
    },
  };
}
