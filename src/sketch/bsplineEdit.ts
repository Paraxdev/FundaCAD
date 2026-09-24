// Editing a control-point spline in the open sketch: inserting and removing a
// pole with the constraints on its poles following along, and turning a
// fit-point spline into one.

import * as THREE from "three";
import type { SketchConstraint } from "../types";
import type { ResolvedEntity } from "./snap";
import {
  bsplineFit, bsplineGreville, bsplineInsertKnot, bsplineNearestParam, bsplinePoint,
  bsplineRange, bsplineRemovePole, bsplineValid, poleOfRef, poleRef, type Pt,
} from "./bspline";
import { splinePolyline } from "./spline";
import { distToSeg } from "./geom2d";

export type BsplineEntity = Extract<ResolvedEntity, { type: "bspline" }>;
type SplineEntity = Extract<ResolvedEntity, { type: "spline" }>;

/** Rewrite the pole references constraints make to entity `id` after its poles
 *  changed: `map` sends an old pole index to its new one, or -1 when the pole is
 *  gone, which drops the constraint. */
export function remapPoleRefs(
  constraints: SketchConstraint[],
  id: string,
  oldN: number,
  newN: number,
  map: (k: number) => number,
): SketchConstraint[] {
  const ref = (e: string, p: number): number | null => {
    if (e !== id) return p;
    const k = map(poleOfRef(p, oldN));
    return k < 0 ? null : poleRef(k, newN);
  };
  const out: SketchConstraint[] = [];
  for (const c of constraints) {
    if (c.type === "coincident" || c.type === "p2pDistance" || c.type === "symmetric") {
      const p1 = ref(c.e1, c.p1), p2 = ref(c.e2, c.p2);
      if (p1 !== null && p2 !== null) out.push({ ...c, p1, p2 });
    } else if (c.type === "midpoint" || c.type === "p2lDistance" || c.type === "p2cDistance" || c.type === "fix") {
      const p = ref(c.e, c.p);
      if (p !== null) out.push({ ...c, p });
    } else {
      out.push(c);
    }
  }
  return out;
}

const same = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

/** Old pole index to new one after an insertion, by the poles it copied unchanged. */
function copiedPoles(before: Pt[], after: Pt[]): (k: number) => number {
  const to = new Map<number, number>();
  let j = 0;
  before.forEach((q, i) => {
    for (let s = j; s < after.length; s++) {
      if (same(q, after[s]!)) { to.set(i, s); j = s + 1; return; }
    }
  });
  return (k) => to.get(k) ?? -1;
}

/** The parameter a click on the control polygon stands for: the matching point
 *  between the two poles' Greville abscissae. Null when no leg is within `tol`. */
export function polygonParam(e: BsplineEntity, click: Pt, tol: number): number | null {
  const g = bsplineGreville(e);
  const [a, b] = bsplineRange(e);
  const n = e.poles.length;
  let best: number | null = null, bestD = tol;
  const legs = e.closed ? n : n - 1;
  for (let i = 0; i < legs; i++) {
    const P = e.poles[i]!, Q = e.poles[(i + 1) % n]!;
    const d = distToSeg(new THREE.Vector2(P.x, P.y), new THREE.Vector2(Q.x, Q.y), new THREE.Vector2(click.x, click.y));
    if (d >= bestD) continue;
    const dx = Q.x - P.x, dy = Q.y - P.y;
    const s = Math.max(0, Math.min(1, ((click.x - P.x) * dx + (click.y - P.y) * dy) / (dx * dx + dy * dy || 1)));
    const g0 = g[i]!;
    let g1 = g[(i + 1) % n]!;
    if (e.closed && g1 <= g0) g1 += b - a;
    let t = g0 + (g1 - g0) * s;
    if (e.closed && t >= b) t -= b - a;
    bestD = d;
    best = t;
  }
  return best;
}

/** Insert a pole where `click` lands on the curve or its control polygon, without
 *  moving the curve. Returns the new entity, its constraints and the new pole
 *  nearest the click; null when nothing is under the click or a knot is already there. */
export function insertPole(
  e: BsplineEntity,
  click: Pt,
  tol: number,
  constraints: SketchConstraint[],
  onPolygon = true,
): { entity: BsplineEntity; constraints: SketchConstraint[]; pole: number } | null {
  if (!bsplineValid(e)) return null;
  let t = onPolygon ? polygonParam(e, click, tol) : null;
  if (t === null) {
    const u = bsplineNearestParam(e, click);
    const c = bsplinePoint(e, u);
    if (Math.hypot(c.x - click.x, c.y - click.y) > tol) return null;
    t = u;
  }
  const next = bsplineInsertKnot(e, t);
  if (!next) return null;
  const entity: BsplineEntity = { ...e, poles: next.poles, ...(next.knots ? { knots: next.knots } : {}) };
  let pole = 0, pd = Infinity;
  entity.poles.forEach((q, k) => {
    const d = Math.hypot(q.x - click.x, q.y - click.y);
    if (d < pd) { pd = d; pole = k; }
  });
  const map = copiedPoles(e.poles, entity.poles);
  return { entity, constraints: remapPoleRefs(constraints, e.id, e.poles.length, entity.poles.length, map), pole };
}

/** Remove pole `k`, or null at the fewest poles the degree allows. */
export function deletePole(
  e: BsplineEntity,
  k: number,
  constraints: SketchConstraint[],
): { entity: BsplineEntity; constraints: SketchConstraint[] } | null {
  const next = bsplineRemovePole(e, k);
  if (!next) return null;
  const { knots: _old, ...rest } = e;
  const entity: BsplineEntity = { ...rest, poles: next.poles, ...(next.knots ? { knots: next.knots } : {}) };
  const map = (i: number) => (i < k ? i : i > k ? i - 1 : -1);
  return { entity, constraints: remapPoleRefs(constraints, e.id, e.poles.length, entity.poles.length, map) };
}

/** A fit-point spline as a control-point one, keeping its id. The poles are a
 *  least-squares fit to the spline as the sketch draws it, with more poles until
 *  it is within 0.2% of the curve's size, so it is close but not exact. An open
 *  spline keeps both ends exactly, and the constraints on them. A closed spline
 *  (its first point on its last) becomes a closed curve, which has no ends, so
 *  the constraints on its points are dropped. */
export function splineToBspline(
  e: SplineEntity,
  constraints: SketchConstraint[],
): { entity: BsplineEntity; constraints: SketchConstraint[] } | null {
  const pts = e.points;
  if (pts.length < 2) return null;
  const a = pts[0]!, z = pts[pts.length - 1]!;
  const closed = pts.length > 3 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-9;
  const c = e.construction ? { construction: true } : {};
  if (pts.length === 2) {
    return { entity: { type: "bspline", id: e.id, poles: pts.map((q) => ({ x: q.x, y: q.y })), ...c }, constraints };
  }
  const samples = splinePolyline(pts, 24).map((q) => ({ x: q.x, y: q.y }));
  if (closed) samples.pop();
  const xs = samples.map((q) => q.x), ys = samples.map((q) => q.y);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const fitPts = closed ? pts.length - 1 : pts.length;
  let fit: ReturnType<typeof bsplineFit> = null;
  for (let n = Math.max(4, fitPts + 1); n <= Math.min(60, 4 * fitPts + 4); n += Math.max(1, Math.round(n / 4))) {
    const f = bsplineFit(samples, n, closed);
    if (!f) continue;
    fit = f;
    let worst = 0;
    for (const q of samples) {
      const on = bsplinePoint(f, bsplineNearestParam(f, q));
      worst = Math.max(worst, Math.hypot(on.x - q.x, on.y - q.y));
    }
    if (worst <= size * 0.002) break;
  }
  if (!fit) return null;
  const entity: BsplineEntity = { type: "bspline", id: e.id, poles: fit.poles, ...(closed ? { closed: true } : {}), ...c };
  if (!closed) return { entity, constraints };
  return { entity, constraints: remapPoleRefs(constraints, e.id, 0, entity.poles.length, () => -1) };
}
