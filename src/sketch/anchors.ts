// Snap anchors from the model's outline on the sketch plane: face and hole centres, corners and side midpoints.
// The plane origin is the world origin projected, often off the face, so these give the user something to aim at.

import * as THREE from "three";

/** Below this fraction of its bounding box a loop is a seam or sliver; relative, so 2mm and 2m behave alike. */
const DEGENERATE_AREA_FRACTION = 1e-6;

/** Twice the signed area; the sign is orientation, which tells a hole from an outline. */
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

/** Area centroid, not vertex average: a tessellated arc brings far more vertices than a straight side.
 *  Falls back to the vertex average only for a loop that encloses no area. */
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

/** Not deduplicated against the sketch's own snap candidates, so the anchors depend on the model alone
 *  and do not come and go as entities are drawn on top of them. */
export function footprintAnchors(loops: readonly (readonly THREE.Vector2[])[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const loop of loops) {
    if (isDegenerateLoop(loop)) continue;
    const c = loopCentroid(loop);
    if (c) out.push(c);
  }
  return out;
}

/** Two boundary points closer than this, relative to the outline's size, are the same corner. */
const SAME_CORNER_FRACTION = 1e-6;

/** A closed edge (whole circle, closed spline) has no corners: its ends meet at the kernel's seam. */
export function isClosedPoly(poly: readonly THREE.Vector2[], tol: number): boolean {
  const a = poly[0];
  const b = poly[poly.length - 1];
  return !!a && !!b && poly.length > 2 && a.distanceTo(b) <= tol;
}

/** By arc length, so a curved side's midpoint sits on the curve rather than the chord. */
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

/** The diagonal of everything in the plane, which the corner tolerance is relative to. */
function outlineScale(polys: readonly (readonly THREE.Vector2[])[]): number {
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minx = Math.min(minx, p.x);
      maxx = Math.max(maxx, p.x);
      miny = Math.min(miny, p.y);
      maxy = Math.max(maxy, p.y);
    }
  }
  if (!Number.isFinite(minx) || !Number.isFinite(miny)) return 0;
  return Math.hypot(maxx - minx, maxy - miny);
}

export interface BoundaryAnchors {
  corners: THREE.Vector2[];
  sides: THREE.Vector2[];
}

/** From the unchained B-rep edges (faceFootprint.planeEdgePolys): on a chained loop a tessellated arc turns
 *  like a real corner. Corners are deduplicated, coincident side midpoints are overlapping edges and stay. */
export function boundaryAnchors(polys: readonly (readonly THREE.Vector2[])[]): BoundaryAnchors {
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
