// How large a blend the geometry AROUND an edge can actually hold.
//
// The drag used to be bounded by one number for the whole document, a quarter of
// the model's bbox diagonal, which is wrong in both directions at once. A
// 100x100x2 plate has a 141mm diagonal, so the drag reached a 35mm fillet on a 2mm
// rim; on a chunky part the same fraction refused fillets the kernel would have
// built. The real constraint is LOCAL: a blend fails when it runs out of face to
// sit on, which is decided by what is near THIS edge.
//
// Measured against EDGES, not faces. The sidecar has the real thing (edge-to-
// nearest-non-touching-FACE via BRepExtrema, tools/gen_fillet_corpus.py) but it is
// behind a round-trip and this number is needed live during a drag. Where the two
// differ this reads SMALLER, which is the safe direction for a bound.
//
// No THREE, no DOM, so vitest reaches it with no viewport.

export type Pt3 = readonly [number, number, number];

/** One edge as the viewport already stores it (viewport/edgeLines.EdgeRef).
 *  Structural rather than the real type so the tests need no THREE import. */
export interface ClearanceEdge {
  readonly id: string;
  readonly points: readonly Pt3[];
}

/** Half, because a blend eats into BOTH sides of the gap it sits in.
 *
 *  Two features a distance d apart each get to grow d/2 before they collide, so
 *  the far wall of a 2mm plate permits a 1mm rim fillet and not a hair more.
 *  Filleting only one of the pair is the common case and would permit the full
 *  d, but the bound has to hold for the selection the user actually made, and
 *  they routinely pick both rims at once. */
export const CLEARANCE_SHARE = 0.5;

/** Distance below which two edges count as touching rather than as neighbours.
 *
 *  Edges meeting at a shared vertex are at distance 0, and they are not a
 *  constraint, the two faces along the picked edge are precisely what the blend
 *  is meant to run across, and their bounding edges meet it at the corners. If
 *  those counted, every clearance would be 0 and the tool would refuse
 *  everything. Scaled to the model so it means the same thing on a 6mm cube and
 *  a 400mm plate; the floor covers a document with no geometry to scale by. */
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

/** Squared distance between two finite segments.
 *
 *  Ericson's ClosestPtSegmentSegment, clamped-parameter form. The degenerate
 *  branches are not defensive padding: a tessellated polyline routinely carries
 *  a zero-length segment where a curve was sampled at a cusp, and the
 *  general-case denominator is exactly 0 there, so without them the measure
 *  returns NaN and the bound silently becomes Infinity. */
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
    // both degenerate: point to point
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
      // denom == 0 means parallel; any s does, so start at 0 and let the
      // clamping below place t.
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

/** Squared distance between two boxes, 0 when they overlap. A lower bound on
 *  the distance between anything inside them, which is what makes it usable as
 *  the reject test below. */
export function boxDistanceSq(a: Aabb, b: Aabb): number {
  const gx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const gy = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  const gz = Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]);
  return gx * gx + gy * gy + gz * gz;
}

/** Shortest distance between two polylines, or Infinity if either is empty.
 *
 *  `bestSq` lets the caller pass the best distance found so far: any pair whose
 *  boxes are already further apart than that cannot improve on it, so the
 *  segment loop is skipped entirely. On an imported assembly this is the
 *  difference between a measure that is free and one that stalls the selection,
 *  the overwhelming majority of edges are nowhere near the picked one, and each
 *  is rejected on a single box test. */
export function polylineDistance(
  a: readonly Pt3[],
  b: readonly Pt3[],
  bestSq = Infinity,
): number {
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

/** For a CLOSED edge, the blend's own turning radius as an upper bound, null for
 *  an open one.
 *
 *  Nearest-neighbour distance misses this entirely: the top rim of a tall thin
 *  cylinder is height/2 from the bottom rim and measures as roomy, but a fillet on
 *  it sweeps inward across the cap and runs out of cap at the axis. Half the
 *  largest bbox extent, exactly r for a circle. */
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
  // Closed means the tessellation brought the polyline back to where it began.
  // Relative to the loop's own size, so it reads the same on a 0.5mm hole and a
  // 400mm bore.
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  if (gap > span * 1e-4) return null;
  return span / 2;
}

export interface ClearanceRequest {
  /** the edges the blend would be applied to */
  selected: readonly ClearanceEdge[];
  /** every edge of the bodies involved, selected ones included (they are
   *  filtered out by id, so the caller can hand over the body's list as-is) */
  all: readonly ClearanceEdge[];
  /** the model's bounding-box diagonal, for the touch tolerance's scale */
  modelScale: number;
}

/** The nearest thing the blend could collide with, in mm, or null when nothing
 *  qualifies and the caller should fall back to its global bound.
 *
 *  Null rather than Infinity, and the distinction is load-bearing: "nothing is
 *  near this edge" is a real answer on a lone primitive, but so is "we could not
 *  measure", and only the second should hand the decision back. Both arrive here
 *  as no-qualifying-neighbour, so neither may claim to be a measurement. */
export function localClearance(req: ClearanceRequest): number | null {
  const { selected, all, modelScale } = req;
  if (selected.length === 0 || all.length === 0) return null;

  const tol = touchTolerance(modelScale);
  const tolSq = tol * tol;
  const picked = new Set(selected.map((e) => e.id));

  const targets: { pts: readonly Pt3[]; box: Aabb }[] = [];
  // A closed pick's own turning radius bounds the answer before any neighbour is
  // consulted, and on a lone cylinder it is the ONLY bound there is.
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
      // Cheap reject first, then the only-if-it-could-win reject. Note this
      // cannot skip a TOUCHING neighbour early, touching pairs have box
      // distance 0, which never rejects, so the tolerance test below still
      // runs on exactly the pairs that need it.
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

/** The largest blend the neighbourhood permits, from a measured clearance.
 *
 *  Deliberately NOT a hard promise that this value builds, OCCT's own limit
 *  depends on curvature and on how the blend runs off the ends of the chain,
 *  neither of which a distance can see. It is a bound that keeps the drag inside
 *  the range where success is plausible, which is all the old diagonal fraction
 *  was ever trying to be, done locally. */
export function clearanceLimit(clearance: number | null): number | null {
  if (clearance == null || !Number.isFinite(clearance) || clearance <= 0) return null;
  return clearance * CLEARANCE_SHARE;
}
