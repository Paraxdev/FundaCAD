// The middle of the face you are sketching on.
//
// Enter a sketch on a face and the plane's origin is the world origin projected
// onto it (planeMath), which is a defensible choice for coordinates and a poor
// one for drawing: on a boss 20mm out along the part, the grid's origin and the
// axis arrows sit off in space with nothing under them, and the face itself
// offers no point to start from. A rectangle centred on the face — the commonest
// thing anyone draws on one — had nothing to aim at.
//
// So the face contributes ANCHORS: its own centre, and the centre of every hole
// in it. They are snap targets like any other, and the alignment guides in
// snap.ts run off them too, which is what makes "centred on this face" and
// "lined up with that hole" gestures rather than arithmetic.
//
// The outline itself is already computed for region detection (faceFootprint),
// so this is one pass over loops that were walked anyway.

import * as THREE from "three";

/** A loop smaller than this in area is a seam or a sliver, not a face worth
 *  offering a centre for. Relative to the loop's own bounding box, so it means
 *  the same thing on a 2mm hole and a 2m panel. */
const DEGENERATE_AREA_FRACTION = 1e-6;

/** Twice the signed area of a closed polygon. Sign is orientation, which is how
 *  a hole is told from an outline; magnitude is what the centroid divides by. */
export function signedArea2(loop: readonly THREE.Vector2[]): number {
  const n = loop.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % n]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** The centroid of the AREA a closed polygon encloses — not the average of its
 *  vertices.
 *
 *  The distinction is the whole point of doing it properly. A tessellated round
 *  face arrives with a hundred vertices along its arc and four down a straight
 *  side, so the vertex average is dragged toward the curve; the area centroid of
 *  a circle is its centre however it was sampled, which is what the user means
 *  by "the middle of this face".
 *
 *  Falls back to the vertex average only when the loop encloses no area at all
 *  (a degenerate or open chain), where there is nothing better and the average
 *  is at least somewhere on it.
 */
export function loopCentroid(loop: readonly THREE.Vector2[]): THREE.Vector2 | null {
  const n = loop.length;
  if (!n) return null;
  if (!loop.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const a2 = signedArea2(loop);
  if (Math.abs(a2) > 1e-12) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const p = loop[i]!;
      const q = loop[(i + 1) % n]!;
      const w = p.x * q.y - q.x * p.y;
      cx += (p.x + q.x) * w;
      cy += (p.y + q.y) * w;
    }
    return new THREE.Vector2(cx / (3 * a2), cy / (3 * a2));
  }
  let sx = 0;
  let sy = 0;
  for (const p of loop) {
    sx += p.x;
    sy += p.y;
  }
  return new THREE.Vector2(sx / n, sy / n);
}

/** True when the loop encloses so little of its own bounding box that its
 *  "centre" would be meaningless — a seam traced out and back, or three points
 *  in a line. */
export function isDegenerateLoop(loop: readonly THREE.Vector2[]): boolean {
  if (loop.length < 3) return true;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of loop) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  const box = (maxx - minx) * (maxy - miny);
  if (!(box > 0)) return true;
  return Math.abs(signedArea2(loop)) / 2 < box * DEGENERATE_AREA_FRACTION;
}

/** One anchor per loop of the model's outline on this sketch plane: the face's
 *  centre, and the centre of each hole through it.
 *
 *  Deliberately NOT deduplicated against the sketch's own snap candidates. A
 *  circle drawn concentric with a hole leaves two anchors in the same place,
 *  which costs one comparison during a snap and keeps this a function of the
 *  MODEL alone — a face anchor that disappeared because a sketch entity happened
 *  to sit on it would be a snap target that came and went as you drew.
 */
export function footprintAnchors(
  loops: readonly (readonly THREE.Vector2[])[],
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const loop of loops) {
    if (isDegenerateLoop(loop)) continue;
    const c = loopCentroid(loop);
    if (c) out.push(c);
  }
  return out;
}

// --- the edge of the face itself ---------------------------------------
//
// The centre answers "in the middle of this face". The two things people reach
// for next are its CORNERS and the middle of each SIDE — "level with that
// corner", "centred on this edge" — and neither had anything to aim at, so both
// were arithmetic.
//
// Taken from the plane's edges BEFORE they are chained into loops
// (faceFootprint.planeEdgePolys), because a B-rep edge already knows where it
// starts and stops. Recovering the same thing from a chained loop means judging
// turn angles, and a 90-degree arc tessellated into four samples turns 22 degrees
// at each of them: indistinguishable from a real corner by any threshold that
// does not also throw real corners away.

/** Two boundary points closer than this, relative to the outline's own size,
 *  are the same corner. Relative so it means the same on a 2mm tab and a 2m
 *  panel; a shared corner arrives twice, once from each edge that ends there,
 *  and the two copies are the same point up to the rounding the wire applied. */
const SAME_CORNER_FRACTION = 1e-6;

/** True when a polyline comes back to where it started — a whole circle or
 *  closed spline, arriving as ONE edge.
 *
 *  Such an edge has no corners: the point where its ends meet is the surface's
 *  seam, which is a fact about how the kernel parameterised it and not about the
 *  shape. Offering it as an anchor would put a snap target at three o'clock on
 *  every hole for no reason anyone could see. */
export function isClosedPoly(poly: readonly THREE.Vector2[], tol: number): boolean {
  const a = poly[0];
  const b = poly[poly.length - 1];
  return !!a && !!b && poly.length > 2 && a.distanceTo(b) <= tol;
}

/** The point half way along a polyline BY ARC LENGTH, so a curved side's
 *  midpoint sits on the curve rather than on the chord. Null for a polyline
 *  with no length. */
export function polylineMidpoint(poly: readonly THREE.Vector2[]): THREE.Vector2 | null {
  if (poly.length < 2) return null;
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = poly[i]!.distanceTo(poly[i - 1]!);
    if (!Number.isFinite(d)) return null;
    total += d;
  }
  if (!(total > 0)) return null;
  let run = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const seg = a.distanceTo(b);
    if (run + seg >= total / 2) {
      const t = seg > 0 ? (total / 2 - run) / seg : 0;
      return a.clone().lerp(b, t);
    }
    run += seg;
  }
  return poly[poly.length - 1]!.clone();
}

/** The scale the corner tolerance is measured against: the diagonal of
 *  everything in the plane. Zero (a single point, or nothing) leaves the
 *  tolerance at its floor rather than collapsing it to exact equality. */
function outlineScale(polys: readonly (readonly THREE.Vector2[])[]): number {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
      miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
    }
  }
  if (!Number.isFinite(minx) || !Number.isFinite(miny)) return 0;
  return Math.hypot(maxx - minx, maxy - miny);
}

export interface BoundaryAnchors {
  /** where two boundary edges meet */
  corners: THREE.Vector2[];
  /** the middle of each boundary edge */
  sides: THREE.Vector2[];
}

/** The corners and the side midpoints of the model's outline on a sketch plane.
 *
 *  `polys` is one polyline per in-plane B-rep edge, un-chained. Corners are
 *  deduplicated (a corner belongs to two edges and arrives twice); side
 *  midpoints are not, because two edges with the same midpoint are two edges
 *  lying on top of each other, which is a fact about the model rather than
 *  something to hide.
 */
export function boundaryAnchors(
  polys: readonly (readonly THREE.Vector2[])[],
): BoundaryAnchors {
  const tol = Math.max(1e-9, outlineScale(polys) * SAME_CORNER_FRACTION);
  const corners: THREE.Vector2[] = [];
  const sides: THREE.Vector2[] = [];
  const addCorner = (p: THREE.Vector2 | undefined) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    for (const q of corners) if (q.distanceTo(p) <= tol) return;
    corners.push(p.clone());
  };
  for (const poly of polys) {
    if (poly.length < 2) continue;
    if (isClosedPoly(poly, tol)) continue;
    addCorner(poly[0]);
    addCorner(poly[poly.length - 1]);
    const mid = polylineMidpoint(poly);
    if (mid) sides.push(mid);
  }
  return { corners, sides };
}
