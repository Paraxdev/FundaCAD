// The stress result's surface as drawn: a crease aware Loop subdivision of the engine's tet boundary, for display
// only. Numbers, legend and probe readings keep coming from the engine surface through the parent map.

import type { Vec3 } from "../types";

export interface EngineSurface {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  faceIds?: ArrayLike<number> | undefined;
  vonMises: ArrayLike<number>;
  displacement?: ArrayLike<number> | undefined;
}

export interface DrawnSurface {
  positions: Float32Array;
  indices: Uint32Array;
  values: Float32Array;
  displacement?: Float32Array;
  /** The engine triangle each drawn triangle lies in. */
  parent: Uint32Array;
  /** Six per drawn triangle: (u, v) of each corner in its parent, the weights of the parent's corners being
   *  (1 - u - v, u, v). */
  local: Float32Array;
  level: 0 | 1 | 2;
}

// 200 000 drawn triangles are about 100 000 vertices, about 4 ms a frame to deform on the PC this was measured on.
export const DRAWN_BUDGET = 200_000;

// An edge stays sharp between two B-rep faces folded more than this, or between any two triangles folded more than
// CREASE_ANY, so a box stays a box and a fixed face is not pulled off its support.
const CREASE_FACES_DEG = 15;
const CREASE_ANY_DEG = 40;
const COS_FACES = Math.cos((CREASE_FACES_DEG * Math.PI) / 180);
const COS_ANY = Math.cos((CREASE_ANY_DEG * Math.PI) / 180);

export function refineLevel(triangles: number, budget = DRAWN_BUDGET): 0 | 1 | 2 {
  if (triangles <= 0) return 0;
  if (triangles * 16 <= budget) return 2;
  if (triangles * 4 <= budget) return 1;
  return 0;
}

interface Level {
  positions: Float64Array;
  indices: Uint32Array;
  faceIds: Int32Array | null;
  values: Float64Array;
  displacement: Float64Array | null;
  parent: Uint32Array;
  local: Float64Array;
}

export function refineSurface(s: EngineSurface, level: 0 | 1 | 2): DrawnSurface {
  const triangles = Math.floor(s.indices.length / 3);
  const local = new Float64Array(triangles * 6);
  const parent = new Uint32Array(triangles);
  for (let t = 0; t < triangles; t++) {
    parent[t] = t;
    local.set([0, 0, 1, 0, 0, 1], t * 6);
  }
  let m: Level = {
    positions: Float64Array.from(s.positions),
    indices: Uint32Array.from(s.indices),
    faceIds: s.faceIds && s.faceIds.length === triangles ? Int32Array.from(s.faceIds) : null,
    values: Float64Array.from(s.vonMises),
    displacement:
      s.displacement && s.displacement.length === s.positions.length ? Float64Array.from(s.displacement) : null,
    parent,
    local,
  };
  for (let i = 0; i < level; i++) m = loopOnce(m);
  const out: DrawnSurface = {
    positions: Float32Array.from(m.positions),
    indices: m.indices,
    values: Float32Array.from(m.values),
    parent: m.parent,
    local: Float32Array.from(m.local),
    level,
  };
  if (m.displacement) out.displacement = Float32Array.from(m.displacement);
  return out;
}

const CHILD_CORNERS = [0, 3, 5, 3, 1, 4, 5, 4, 2, 3, 4, 5];

function loopOnce(m: Level): Level {
  const P = m.positions;
  const I = m.indices;
  const V = P.length / 3;
  const T = I.length / 3;

  const normals = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3]! * 3;
    const b = I[t * 3 + 1]! * 3;
    const c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!;
    const uy = P[b + 1]! - P[a + 1]!;
    const uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!;
    const vy = P[c + 1]! - P[a + 1]!;
    const vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / len;
    normals[t * 3 + 1] = ny / len;
    normals[t * 3 + 2] = nz / len;
  }

  // Edges: endpoints, the triangles on them and the corner opposite in the first two.
  const edgeOf = new Uint32Array(T * 3);
  const keys = new Map<number, number>();
  const ea: number[] = [];
  const eb: number[] = [];
  const tris: number[] = [];
  const count: number[] = [];
  const opp: number[] = [];
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k]!;
      const b = I[t * 3 + ((k + 1) % 3)]!;
      const c = I[t * 3 + ((k + 2) % 3)]!;
      const key = a < b ? a * V + b : b * V + a;
      let e = keys.get(key);
      if (e === undefined) {
        e = ea.length;
        keys.set(key, e);
        ea.push(a);
        eb.push(b);
        tris.push(t, -1);
        opp.push(c, -1);
        count.push(0);
      } else if (count[e] === 1) {
        tris[e * 2 + 1] = t;
        opp[e * 2 + 1] = c;
      }
      count[e]!++;
      edgeOf[t * 3 + k] = e;
    }
  }
  const E = ea.length;
  const crease = new Uint8Array(E);
  for (let e = 0; e < E; e++) {
    if (count[e] !== 2) {
      crease[e] = 1;
      continue;
    }
    const t0 = tris[e * 2]!;
    const t1 = tris[e * 2 + 1]!;
    const cos =
      normals[t0 * 3]! * normals[t1 * 3]! +
      normals[t0 * 3 + 1]! * normals[t1 * 3 + 1]! +
      normals[t0 * 3 + 2]! * normals[t1 * 3 + 2]!;
    const otherFace = m.faceIds !== null && m.faceIds[t0] !== m.faceIds[t1];
    if (cos < COS_ANY || (otherFace && cos < COS_FACES)) crease[e] = 1;
  }

  const fields: Float64Array[] = [P];
  if (m.displacement) fields.push(m.displacement);
  const valence = new Uint32Array(V);
  const creases = new Uint32Array(V);
  const ringSum = fields.map(() => new Float64Array(V * 3));
  const creaseSum = fields.map(() => new Float64Array(V * 3));
  for (let e = 0; e < E; e++) {
    const a = ea[e]!;
    const b = eb[e]!;
    valence[a]!++;
    valence[b]!++;
    if (crease[e]) {
      creases[a]!++;
      creases[b]!++;
    }
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const ring = ringSum[i]!;
      const sharp = creaseSum[i]!;
      for (let c = 0; c < 3; c++) {
        ring[a * 3 + c]! += f[b * 3 + c]!;
        ring[b * 3 + c]! += f[a * 3 + c]!;
        if (crease[e]) {
          sharp[a * 3 + c]! += f[b * 3 + c]!;
          sharp[b * 3 + c]! += f[a * 3 + c]!;
        }
      }
    }
  }

  const NV = V + E;
  const next = fields.map(() => new Float64Array(NV * 3));
  fields.forEach((f, i) => {
    const out = next[i]!;
    for (let v = 0; v < V; v++) {
      const n = valence[v]!;
      for (let c = 0; c < 3; c++) {
        const x = f[v * 3 + c]!;
        let y = x;
        if (creases[v]! === 2) y = 0.75 * x + 0.125 * creaseSum[i]![v * 3 + c]!;
        else if (creases[v]! < 2 && n > 0) {
          const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
          y = (1 - n * beta) * x + beta * ringSum[i]![v * 3 + c]!;
        }
        out[v * 3 + c] = y;
      }
    }
    for (let e = 0; e < E; e++) {
      const a = ea[e]!;
      const b = eb[e]!;
      for (let c = 0; c < 3; c++) {
        const mid = f[a * 3 + c]! + f[b * 3 + c]!;
        out[(V + e) * 3 + c] = crease[e]
          ? mid / 2
          : 0.375 * mid + 0.125 * (f[opp[e * 2]! * 3 + c]! + f[opp[e * 2 + 1]! * 3 + c]!);
      }
    }
  });

  // The colour keeps its engine value at old vertices, so the peak stays the peak; all weights are positive, so no
  // drawn value leaves the engine's range.
  const values = new Float64Array(NV);
  values.set(m.values);
  for (let e = 0; e < E; e++) {
    const mid = m.values[ea[e]!]! + m.values[eb[e]!]!;
    values[V + e] = crease[e] ? mid / 2 : 0.375 * mid + 0.125 * (m.values[opp[e * 2]!]! + m.values[opp[e * 2 + 1]!]!);
  }

  const indices = new Uint32Array(T * 12);
  const faceIds = m.faceIds ? new Int32Array(T * 4) : null;
  const parent = new Uint32Array(T * 4);
  const local = new Float64Array(T * 24);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3]!;
    const b = I[t * 3 + 1]!;
    const c = I[t * 3 + 2]!;
    const ab = V + edgeOf[t * 3]!;
    const bc = V + edgeOf[t * 3 + 1]!;
    const ca = V + edgeOf[t * 3 + 2]!;
    const o = t * 12;
    indices[o] = a;
    indices[o + 1] = ab;
    indices[o + 2] = ca;
    indices[o + 3] = ab;
    indices[o + 4] = b;
    indices[o + 5] = bc;
    indices[o + 6] = ca;
    indices[o + 7] = bc;
    indices[o + 8] = c;
    indices[o + 9] = ab;
    indices[o + 10] = bc;
    indices[o + 11] = ca;
    // Corner (u, v) of a, b, c in the engine parent, and of the edge midpoints between them, in the order above.
    const L = m.local;
    const l = t * 6;
    const corners = [
      L[l]!,
      L[l + 1]!,
      L[l + 2]!,
      L[l + 3]!,
      L[l + 4]!,
      L[l + 5]!,
      (L[l]! + L[l + 2]!) / 2,
      (L[l + 1]! + L[l + 3]!) / 2,
      (L[l + 2]! + L[l + 4]!) / 2,
      (L[l + 3]! + L[l + 5]!) / 2,
      (L[l + 4]! + L[l]!) / 2,
      (L[l + 5]! + L[l + 1]!) / 2,
    ];
    // a, b, c are corners 0, 1, 2 and ab, bc, ca are 3, 4, 5.
    const order = CHILD_CORNERS;
    for (let k = 0; k < 12; k++) {
      local[t * 24 + k * 2] = corners[order[k]! * 2]!;
      local[t * 24 + k * 2 + 1] = corners[order[k]! * 2 + 1]!;
    }
    for (let k = 0; k < 4; k++) {
      parent[t * 4 + k] = m.parent[t]!;
      if (faceIds) faceIds[t * 4 + k] = m.faceIds![t]!;
    }
  }

  return {
    positions: next[0]!,
    indices,
    faceIds,
    values,
    displacement: m.displacement ? next[1]! : null,
    parent,
    local,
  };
}

/** A hit on drawn triangle `tri` at barycentric `weights`, as the engine triangle and weights it falls on. */
export function engineHit(d: DrawnSurface, tri: number, weights: Vec3): { tri: number; weights: Vec3 } | null {
  if (!Number.isInteger(tri) || tri < 0 || tri >= d.parent.length) return null;
  let u = 0;
  let v = 0;
  for (let k = 0; k < 3; k++) {
    u += weights[k]! * d.local[tri * 6 + k * 2]!;
    v += weights[k]! * d.local[tri * 6 + k * 2 + 1]!;
  }
  return { tri: d.parent[tri]!, weights: [1 - u - v, u, v] };
}

/** A drawn triangle using `vertex`, with all its weight there. */
export function drawnCorner(d: DrawnSurface, vertex: number): { tri: number; weights: Vec3 } | null {
  for (let i = 0; i < d.indices.length; i++) {
    if (d.indices[i] !== vertex) continue;
    const k = i % 3;
    return { tri: (i - k) / 3, weights: [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0] };
  }
  return null;
}

/** The vertex nearest `at`, -1 when there is none. */
export function nearestVertex(positions: ArrayLike<number>, at: Vec3): number {
  let best = -1;
  let bestD = Infinity;
  for (let v = 0; v * 3 + 2 < positions.length; v++) {
    const d =
      (positions[v * 3]! - at[0]) ** 2 + (positions[v * 3 + 1]! - at[1]) ** 2 + (positions[v * 3 + 2]! - at[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}
