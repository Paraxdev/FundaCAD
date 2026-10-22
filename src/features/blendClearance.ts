// How large a blend the geometry around an edge can hold. It is local, as a 100x100x2 plate has a 141 mm diagonal
// but a 2 mm rim, and a blend fails when it runs out of nearby face. No THREE or DOM, so vitest runs it headless.

export type Pt3 = readonly [number, number, number];

/** viewport/edgeLines.EdgeRef, structural so the tests need no THREE import. */
export interface ClearanceEdge {
  readonly id: string;
  readonly points: readonly Pt3[];
}

/** A blend eats into both sides of a gap, and users often pick both rims at once, so a 2mm plate allows a 1mm
 *  rim fillet. */
export const CLEARANCE_SHARE = 0.5;

/** Edges sharing a vertex are at distance 0 but are what the blend runs across, not a constraint. Scaled to the
 *  model, with a floor for a document with no geometry. */
export function touchTolerance(modelScale: number): number {
  const s = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 0;
  return Math.max(1e-7, s * 1e-5);
}

type Vec3 = [number, number, number];

function sub(a: Pt3, b: Pt3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Ericson's ClosestPtSegmentSegment. Tessellation leaves zero length segments at cusps where the general
 *  denominator is 0, so the degenerate branches keep NaN from turning the bound into Infinity. */
export function segmentDistanceSq(p1: Pt3, q1: Pt3, p2: Pt3, q2: Pt3): number {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s: number;
  let t: number;

  if (a <= 1e-20 && e <= 1e-20) {
    return dot(r, r);
  }
  if (a <= 1e-20) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= 1e-20) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      // denom 0 means parallel; any s does, so start at 0 and let the clamp place t.
      s = denom > 1e-20 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }

  const cx = p1[0] + d1[0] * s - (p2[0] + d2[0] * t);
  const cy = p1[1] + d1[1] * s - (p2[1] + d2[1] * t);
  const cz = p1[2] + d1[2] * s - (p2[2] + d2[2] * t);
  return cx * cx + cy * cy + cz * cz;
}

export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

export function polylineBox(points: readonly Pt3[]): Aabb | null {
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const pt of points) {
    const [x, y, z] = pt;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/** 0 when they overlap. A lower bound on the distance between anything inside them, hence the reject test. */
export function boxDistanceSq(a: Aabb, b: Aabb): number {
  const gx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const gy = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  const gz = Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]);
  return gx * gx + gy * gy + gz * gz;
}

/** Infinity if either is empty. Pairs whose boxes are already further apart than `bestSq` are skipped, which keeps
 *  the measure from stalling the selection on an imported assembly. */
export function polylineDistance(a: readonly Pt3[], b: readonly Pt3[], bestSq = Infinity): number {
  if (a.length < 2 || b.length < 2) return Infinity;
  let best = bestSq;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i];
    const a1 = a[i + 1];
    if (!a0 || !a1) continue;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j];
      const b1 = b[j + 1];
      if (!b0 || !b1) continue;
      const d = segmentDistanceSq(a0, a1, b0, b1);
      if (d < best) best = d;
    }
  }
  return best === Infinity ? Infinity : Math.sqrt(best);
}

/** Upper bound for a closed edge, null for an open one: a tall cylinder's top rim measures roomy, but its fillet
 *  runs out of cap at the axis. Half the largest bbox extent, r for a circle. */
export function closedLoopRadius(points: readonly Pt3[]): number | null {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const box = polylineBox(points);
  if (!box) return null;
  const ex = box.max[0] - box.min[0];
  const ey = box.max[1] - box.min[1];
  const ez = box.max[2] - box.min[2];
  const span = Math.max(ex, ey, ez);
  if (!(span > 0)) return null;
  // Relative to the loop's own size, so it reads the same on a 0.5mm hole and a 400mm bore.
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  if (gap > span * 1e-4) return null;
  return span / 2;
}

export interface ClearanceRequest {
  selected: readonly ClearanceEdge[];
  /** may include the selected edges, they are filtered out by id */
  all: readonly ClearanceEdge[];
  /** the model's bounding box diagonal */
  modelScale: number;
}

/** mm, or null rather than Infinity when nothing qualifies, so "could not measure" never passes as a measurement.
 *  Edge to edge, live; the engine's face check (tools/gen_fillet_corpus.py) is a round trip and reads larger. */
export function localClearance(req: ClearanceRequest): number | null {
  const { selected, all, modelScale } = req;
  if (selected.length === 0 || all.length === 0) return null;

  const tol = touchTolerance(modelScale);
  const tolSq = tol * tol;
  const picked = new Set(selected.map((e) => e.id));

  const targets: { pts: readonly Pt3[]; box: Aabb }[] = [];
  // A closed pick's own turning radius bounds the answer, and on a lone cylinder it is the only bound.
  let cap = Infinity;
  for (const e of selected) {
    const box = polylineBox(e.points);
    if (box && e.points.length >= 2) targets.push({ pts: e.points, box });
    const loop = closedLoopRadius(e.points);
    if (loop != null && loop < cap) cap = loop;
  }
  if (targets.length === 0) return null;

  let bestSq = cap === Infinity ? Infinity : cap * cap;
  for (const other of all) {
    if (picked.has(other.id)) continue;
    if (other.points.length < 2) continue;
    const box = polylineBox(other.points);
    if (!box) continue;
    for (const t of targets) {
      // Touching pairs have box distance 0, so they are never rejected here and still reach the tolerance test.
      if (boxDistanceSq(box, t.box) >= bestSq) continue;
      const d = polylineDistance(t.pts, other.points, bestSq);
      if (!Number.isFinite(d)) continue;
      const dSq = d * d;
      if (dSq <= tolSq) continue; // shares a vertex: attached, not a constraint
      if (dSq < bestSq) bestSq = dSq;
    }
  }

  return Number.isFinite(bestSq) ? Math.sqrt(bestSq) : null;
}

/** Not a promise that this builds: OCCT's limit also depends on curvature and the chain's ends. It only sizes the
 *  opening value (seedValue) and must never bound the drag. */
export function clearanceLimit(clearance: number | null): number | null {
  if (clearance == null || !Number.isFinite(clearance) || clearance <= 0) return null;
  return clearance * CLEARANCE_SHARE;
}
