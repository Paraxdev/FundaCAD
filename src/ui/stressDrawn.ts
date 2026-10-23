// The stress result drawn on the part's own display mesh: split flat until its edges are as short as the solver's
// elements nearby, then coloured and bent by the solver's fields read where each point lies on the tet boundary.

import type { Vec3 } from "../types";
import { closestWeights, vonMisesAt, type EngineSurface, type Locator } from "./stressLocate";

export interface DisplayMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** One global B-rep face id per triangle. */
  faceIds: Int32Array;
  faceStart: number;
}

export interface DrawnSurface {
  /** Rest positions, the overlay bends them by `displacement`. */
  positions: Float32Array;
  indices: Uint32Array;
  values: Float32Array;
  displacement?: Float32Array;
  /** The body local face of each drawn triangle, -1 for none. */
  faces: Int32Array;
}

// Splitting and sampling take about 9 us per drawn triangle (Wall bracket: 69000 in 0.7 s), so this caps it near 1.3 s.
export const DRAWN_BUDGET = 150_000;
// Halving splits leave triangles of about a fifth of an equilateral one's 0.433 L^2 (a box: 3.1 to 4.1 times
// the equilateral count), so the budget predicts with this area per triangle.
const TRIANGLE_AREA = 0.08;
const MAX_PASSES = 16;
// Edge keys pack two vertex ids, below 2^26 each, into one number.
const KEY = 2 ** 26;
// The engine rounds positions to 4 places, so coincident vertices of two faces weld at that grid.
const WELD = 1e4;

function weldIds(positions: ArrayLike<number>): Uint32Array {
  const n = Math.floor(positions.length / 3);
  const ids = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const key = [0, 1, 2].map((k) => Math.round(positions[v * 3 + k]! * WELD)).join(",");
    const id = seen.get(key);
    if (id === undefined) {
      seen.set(key, v);
      ids[v] = v;
    } else ids[v] = id;
  }
  return ids;
}

function at(positions: ArrayLike<number>, v: number): Vec3 {
  return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Splits edges at their midpoints until each is no longer than the engine edge length near it, longest first in
 *  passes of halving. An edge is decided by its welded ends, so both faces along a B-rep edge split it at the same
 *  point. When the predicted count passes `budget` every target grows by the square root of the excess. */
export function splitDisplay(m: DisplayMesh, edgeAt: (p: Vec3) => number, budget = DRAWN_BUDGET): DisplayMesh {
  const pos: number[] = Array.from(m.positions);
  let tris: number[] = Array.from(m.indices);
  let faces: number[] = Array.from(m.faceIds);
  let predicted = 0;
  for (let t = 0; t * 3 + 2 < tris.length; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => at(pos, tris[t * 3 + k]!)) as [Vec3, Vec3, Vec3];
    const mid: Vec3 = [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3) as Vec3;
    const l = edgeAt(mid);
    if (l > 0) predicted += triangleArea(a, b, c) / (TRIANGLE_AREA * l * l);
  }
  const grow = predicted > budget ? Math.sqrt(predicted / budget) : 1;
  const target = new Map<number, number>();
  const weld: number[] = Array.from(weldIds(m.positions));
  const pair = (a: number, b: number) => (a < b ? a * KEY + b : b * KEY + a);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Midpoints by the edge's own vertices, which no other face shares, and the weld id each takes by its welded ends.
    const split = new Map<number, number>();
    const shared = new Map<number, number>();
    const edgeKey = (u: number, v: number) => pair(weld[u]!, weld[v]!);
    const wants = (u: number, v: number) => {
      const key = edgeKey(u, v);
      const pu = at(pos, u);
      const pv = at(pos, v);
      let l = target.get(key);
      if (l === undefined) {
        l = edgeAt([(pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2]) * grow;
        target.set(key, l);
      }
      return l > 0 && distance(pu, pv) > l;
    };
    const mid = (u: number, v: number) => {
      const key = pair(u, v);
      let id = split.get(key);
      if (id === undefined) {
        const [lo, hi] = weld[u]! < weld[v]! ? [u, v] : [v, u];
        id = pos.length / 3;
        for (let k = 0; k < 3; k++) pos.push((pos[lo * 3 + k]! + pos[hi * 3 + k]!) / 2);
        const w = edgeKey(u, v);
        const other = shared.get(w);
        weld.push(other ?? id);
        if (other === undefined) shared.set(w, id);
        split.set(key, id);
      }
      return id;
    };
    const next: number[] = [];
    const nextFaces: number[] = [];
    let any = false;
    for (let t = 0; t * 3 + 2 < tris.length; t++) {
      const v = [tris[t * 3]!, tris[t * 3 + 1]!, tris[t * 3 + 2]!];
      const f = faces[t]!;
      const cut = [0, 1, 2].map((k) => wants(v[k]!, v[(k + 1) % 3]!));
      const n = cut.filter(Boolean).length;
      if (!n) {
        next.push(...v);
        nextFaces.push(f);
        continue;
      }
      any = true;
      const ms = [0, 1, 2].map((k) => (cut[k] ? mid(v[k]!, v[(k + 1) % 3]!) : -1));
      const out = n === 3 ? [v[0], ms[0], ms[2], ms[0], v[1], ms[1], ms[2], ms[1], v[2], ms[0], ms[1], ms[2]] : null;
      if (out) next.push(...(out as number[]));
      else {
        // Rotate so the first cut edge starts the triangle (a, b, c), its midpoint m on ab.
        const r = n === 1 ? cut.indexOf(true) : cut[0] && cut[1] ? 0 : cut[1] && cut[2] ? 1 : 2;
        const [a, b, c] = [v[r]!, v[(r + 1) % 3]!, v[(r + 2) % 3]!];
        const mab = ms[r]!;
        if (n === 1) next.push(a, mab, c, mab, b, c);
        else {
          const mbc = ms[(r + 1) % 3]!;
          next.push(a, mab, c, mab, b, mbc, mab, mbc, c);
        }
      }
      const count = n === 3 ? 4 : n + 1;
      for (let k = 0; k < count; k++) nextFaces.push(f);
    }
    tris = next;
    faces = nextFaces;
    if (!any) break;
  }
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(tris),
    faceIds: new Int32Array(faces),
    faceStart: m.faceStart,
  };
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
}

const clamp = (x: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, x));

/** The display mesh coloured and bent from the engine surface; the engine surface itself when there is no display
 *  mesh. Each vertex reads the engine triangle it lies on, its own face first; displacement is one value per welded
 *  position so the bent surface does not open along an edge. */
export function drawnSurface(
  m: DisplayMesh | null,
  s: EngineSurface,
  locate: Locator,
  range: { min: number; max: number },
): DrawnSurface {
  const moves = !!s.displacement && s.displacement.length === s.positions.length;
  if (!m) {
    const n = Math.floor(s.positions.length / 3);
    const values = new Float32Array(n);
    for (let v = 0; v < n; v++) values[v] = clamp(s.vonMises[v] ?? 0, range);
    const tris = Math.floor(s.indices.length / 3);
    const faces = new Int32Array(tris);
    for (let t = 0; t < tris; t++) faces[t] = s.faceIds?.[t] ?? -1;
    return {
      positions: Float32Array.from(s.positions),
      indices: Uint32Array.from(s.indices),
      values,
      ...(moves ? { displacement: Float32Array.from(s.displacement!) } : {}),
      faces,
    };
  }
  const n = Math.floor(m.positions.length / 3);
  const tris = Math.floor(m.indices.length / 3);
  const faces = new Int32Array(tris);
  const vertexFace = new Int32Array(n).fill(-1);
  for (let t = 0; t < tris; t++) {
    const g = m.faceIds[t]!;
    faces[t] = g >= m.faceStart ? g - m.faceStart : -1;
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k]!;
      if (vertexFace[v]! < 0) vertexFace[v] = faces[t]!;
    }
  }
  const values = new Float32Array(n);
  const disp = moves ? new Float32Array(n * 3) : null;
  for (let v = 0; v < n; v++) {
    const hit = locate.closest(at(m.positions, v), vertexFace[v]!);
    if (!hit) continue;
    const ids = [0, 1, 2].map((k) => s.indices[hit.tri * 3 + k]!);
    values[v] = clamp(vonMisesAt(s, hit.tri, hit.weights), range);
    if (disp)
      for (let j = 0; j < 3; j++) {
        let d = 0;
        for (let k = 0; k < 3; k++) d += hit.weights[k]! * s.displacement![ids[k]! * 3 + j]!;
        disp[v * 3 + j] = d;
      }
  }
  if (disp) {
    const weld = weldIds(m.positions);
    const sum = new Float64Array(n * 3);
    const count = new Uint32Array(n);
    for (let v = 0; v < n; v++) {
      const w = weld[v]!;
      count[w]!++;
      for (let j = 0; j < 3; j++) sum[w * 3 + j]! += disp[v * 3 + j]!;
    }
    for (let v = 0; v < n; v++) {
      const w = weld[v]!;
      for (let j = 0; j < 3; j++) disp[v * 3 + j] = sum[w * 3 + j]! / count[w]!;
    }
  }
  return {
    positions: Float32Array.from(m.positions),
    indices: Uint32Array.from(m.indices),
    values,
    ...(disp ? { displacement: disp } : {}),
    faces,
  };
}

function restPoint(d: DrawnSurface, tri: number, weights: Vec3): Vec3 | null {
  if (!(tri >= 0) || tri * 3 + 2 >= d.indices.length) return null;
  const p: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = d.indices[tri * 3 + k]!;
    for (let j = 0; j < 3; j++) p[j] = p[j]! + weights[k]! * d.positions[v * 3 + j]!;
  }
  return p;
}

/** Where a hit on the drawn surface reads the engine: its rest point located on the engine boundary, its own face
 *  first. The hit's triangle and weights stay valid when the drawn surface is bent. */
export function readAt(
  d: DrawnSurface,
  locate: Locator,
  tri: number,
  weights: Vec3,
): { tri: number; weights: Vec3 } | null {
  const p = restPoint(d, tri, weights);
  const hit = p && locate.closest(p, d.faces[tri] ?? -1);
  return hit ? { tri: hit.tri, weights: hit.weights } : null;
}

/** The point of the drawn triangles of body local face `face` closest to `peak`, of every triangle when the face is
 *  null or has none. */
export function weakSpot(d: DrawnSurface, peak: Vec3, face: number | null): { tri: number; weights: Vec3 } | null {
  const tris = Math.floor(d.indices.length / 3);
  const best = (keep: (t: number) => boolean) => {
    let out: { tri: number; weights: Vec3 } | null = null;
    let bestD = Infinity;
    for (let t = 0; t < tris; t++) {
      if (!keep(t)) continue;
      const [a, b, c] = [0, 1, 2].map((k) => at(d.positions, d.indices[t * 3 + k]!)) as [Vec3, Vec3, Vec3];
      const w = closestWeights(peak, a, b, c);
      const q: Vec3 = [0, 1, 2].map((j) => w[0] * a[j]! + w[1] * b[j]! + w[2] * c[j]!) as Vec3;
      const dist = distance(q, peak);
      if (dist < bestD) {
        bestD = dist;
        out = { tri: t, weights: w };
      }
    }
    return out;
  };
  return (face !== null && best((t) => d.faces[t] === face)) || best(() => true);
}
