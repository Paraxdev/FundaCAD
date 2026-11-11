export type V3 = readonly [number, number, number];
export type Polyline = V3[];

// A closed loop, first point not repeated. joints[i] marks a vertex shared by two model edges.
export interface SweepRing {
  points: V3[];
  joints?: boolean[];
}

// along is mm on the axis, inset is mm toward the material (negative leans out).
export interface Station {
  along: number;
  inset: number;
}

// Rings are world space on the base plane. Outer loops run CCW about normal, holes CW; the sign of the
// loop's area about normal decides which one a ring is. Stations ascend: one sided [(0,0),(d,i)],
// symmetric [(-d,i),(0,0),(d,i)].
export interface SweepSpec {
  rings: SweepRing[];
  normal: V3;
  axis: V3;
  stations: Station[];
}

export const CORNER_DEG = 20;

const ANGLE_EPS = 1e-9;
const FLIP_EPS = 1e-9;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};

function areaAbout(points: V3[], normal: V3): number {
  let sum: V3 = [0, 0, 0];
  const o = points[0]!;
  for (let i = 1; i + 1 < points.length; i++) {
    sum = add(sum, cross(sub(points[i]!, o), sub(points[i + 1]!, o)));
  }
  return dot(sum, normal) / 2;
}

export function cornerFlags(ring: SweepRing, cornerDeg = CORNER_DEG): boolean[] {
  const p = ring.points;
  const n = p.length;
  return p.map((q, i) => {
    if (ring.joints?.[i]) return true;
    const a = sub(q, p[(i + n - 1) % n]!);
    const b = sub(p[(i + 1) % n]!, q);
    if (len(a) === 0 || len(b) === 0) return false;
    const turn = (Math.atan2(len(cross(a, b)), dot(a, b)) * 180) / Math.PI;
    return turn > cornerDeg + ANGLE_EPS;
  });
}

// Moves every vertex along the miter of its two edges, toward the material side. Null when an edge
// flips, collapses or has no length, so the caller can keep the base ring there.
export function insetRing(points: V3[], normal: V3, inset: number, hole: boolean): V3[] | null {
  const n = points.length;
  if (n < 3) return null;
  const ccw = areaAbout(points, normal) > 0;
  const sign = ccw !== hole ? 1 : -1;
  const dirs = points.map((q, i) => unit(sub(points[(i + 1) % n]!, q)));
  const lefts = dirs.map((d) => cross(normal, d));
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lefts[(i + n - 1) % n]!;
    const l2 = lefts[i]!;
    const k = 1 + dot(l1, l2);
    if (k < 1e-6) return null;
    out.push(add(points[i]!, scale(add(l1, l2), (sign * inset) / k)));
  }
  for (let i = 0; i < n; i++) {
    const d = dirs[i]!;
    if (len(d) === 0 || dot(sub(out[(i + 1) % n]!, out[i]!), d) <= FLIP_EPS) return null;
  }
  return out;
}

function stationRing(points: V3[], normal: V3, hole: boolean, st: Station): V3[] {
  return (st.inset === 0 ? null : insetRing(points, normal, st.inset, hole)) ?? points;
}

function closed(points: V3[]): Polyline {
  return [...points, points[0]!];
}

export function sweepPolylines(spec: SweepSpec): Polyline[] {
  const { normal, axis, stations } = spec;
  if (stations.length === 0) return [];
  const out: Polyline[] = [];
  for (const ring of spec.rings) {
    if (ring.points.length < 3) continue;
    const hole = areaAbout(ring.points, normal) < 0;
    const at = stations.map((st) =>
      stationRing(ring.points, normal, hole, st).map((q) => add(q, scale(axis, st.along))),
    );
    out.push(closed(at[0]!));
    if (at.length < 2) continue;
    out.push(closed(at[at.length - 1]!));
    cornerFlags(ring).forEach((corner, v) => {
      if (corner) out.push(at.map((pts) => pts[v]!));
    });
  }
  return out;
}

export function chainLoops(edges: V3[][], tol: number): SweepRing[] {
  const near = (a: V3, b: V3) => len(sub(a, b)) <= tol;
  const used = edges.map((e) => e.length < 2);
  const rings: SweepRing[] = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const first = edges[s]!;
    const taken = [s];
    const chain: V3[][] = [first];
    used[s] = true;
    let end = first[first.length - 1]!;
    const start = first[0]!;
    let closedLoop = near(end, start);
    while (!closedLoop) {
      let found = -1;
      let flip = false;
      for (let j = 0; j < edges.length && found < 0; j++) {
        if (used[j]) continue;
        const e = edges[j]!;
        if (near(e[0]!, end)) found = j;
        else if (near(e[e.length - 1]!, end)) {
          found = j;
          flip = true;
        }
      }
      if (found < 0) break;
      used[found] = true;
      taken.push(found);
      const e = flip ? [...edges[found]!].reverse() : edges[found]!;
      chain.push(e);
      end = e[e.length - 1]!;
      closedLoop = near(end, start);
    }
    if (!closedLoop) {
      for (const t of taken) if (t !== s) used[t] = false;
      continue;
    }
    const points: V3[] = [];
    const joints: boolean[] = [];
    for (const e of chain) {
      e.slice(0, -1).forEach((q, i) => {
        points.push(q);
        joints.push(i === 0 && chain.length > 1);
      });
    }
    rings.push({ points, joints });
  }
  return rings;
}
