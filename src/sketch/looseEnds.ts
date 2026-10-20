// Loose ends of a sketch profile: curve ends that meet nothing (open, drawn red)
// and ends that meet another curve only by position, with no coincident or
// point on curve constraint holding them (untied, drawn amber). Pure, shared
// by the sketch overlay, the Tie Loose Ends command and the tests.
import type { SketchConstraint } from "../types";
import { refPoint } from "./entityDims";
import { entityPolyline } from "./region";
import type { ResolvedEntity } from "./snap";

export interface EndRef { entity: string; p: number; x: number; y: number }
export type Touch = { kind: "end"; entity: string; p: number } | { kind: "curve"; entity: string };
export interface Untied extends EndRef { touches: Touch; gap: number; tieable: boolean }
export interface LooseEnds { open: EndRef[]; untied: Untied[]; capped?: true }

/** Above this many ends the scan is skipped, a huge import would stall the sketcher. */
export const LOOSE_ENDS_CAP = 20000;

const isProfile = (e: ResolvedEntity) => !e.construction && e.type !== "text" && e.type !== "point";

/** The ends a user can tie: open curves only, projected geometry is fixed and never moves. */
function movableEnds(e: ResolvedEntity): number[] {
  if (e.type === "line" || e.type === "arc") return [0, 1];
  if (e.type === "spline") return e.points.length > 1 ? [0, 1] : [];
  if (e.type === "bspline") return !e.closed && e.poles.length > 1 ? [0, 1] : [];
  return [];
}

/** Points another end can land on: movable ends, rectangle corners, projected curve ends. */
function targetEnds(e: ResolvedEntity): number[] {
  if (e.type === "rectangle") return [0, 1, 2, 3];
  if (e.type === "projected") {
    const k = e.curve.kind;
    if (k === "line" || k === "arc") return [0, 1];
    if (k === "poly") {
      const a = e.curve.pts[0], b = e.curve.pts[e.curve.pts.length - 1];
      return a && b && (a[0] !== b[0] || a[1] !== b[1]) ? [0, 1] : [];
    }
    return [];
  }
  return movableEnds(e);
}

/** A pointOnCurve target the solver understands (sketchSolve kindOf: line, circle, arc). */
function curveTieable(e: ResolvedEntity): boolean {
  if (e.type === "line" || e.type === "circle" || e.type === "arc") return true;
  return e.type === "projected" && e.curve.kind !== "poly";
}

/** A curve may close onto itself only when it is free form, a line or arc would collapse. */
const selfClosable = (e: ResolvedEntity) => e.type === "spline" || e.type === "bspline";

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface Curve { e: ResolvedEntity; pts: { x: number; y: number }[]; minX: number; minY: number; maxX: number; maxY: number }

function curveDist(c: Curve, x: number, y: number): number {
  const e = c.e;
  if (e.type === "line") return segDist(x, y, e.x1, e.y1, e.x2, e.y2);
  if (e.type === "circle") return Math.abs(Math.hypot(x - e.x, y - e.y) - e.radius);
  if (e.type === "projected" && e.curve.kind === "circle") {
    return Math.abs(Math.hypot(x - e.curve.x, y - e.curve.y) - e.curve.r);
  }
  let best = Infinity;
  for (let i = 0; i < c.pts.length - 1; i++) {
    const a = c.pts[i]!, b = c.pts[i + 1]!;
    best = Math.min(best, segDist(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

const key = (entity: string, p: number) => `${entity}\u0000${p}`;

class Joins {
  private parent = new Map<string, string>();
  find(k: string): string {
    let r = k;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(k, r);
    return r;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

/** Which ends are held by a constraint: a coincident to another curve's end, or a
 *  pointOnCurve or midpoint on the end itself. */
function tiedEnds(entities: readonly ResolvedEntity[], constraints: readonly SketchConstraint[]): Set<string> {
  const pointIds = new Set(entities.filter((e) => e.type === "point").map((e) => e.id));
  const tied = new Set<string>();
  for (const c of constraints) {
    if (c.type === "coincident") {
      if (c.e1 === c.e2 && c.p1 === c.p2) continue;
      if (!pointIds.has(c.e2)) tied.add(key(c.e1, c.p1));
      if (!pointIds.has(c.e1)) tied.add(key(c.e2, c.p2));
    } else if (c.type === "pointOnCurve" || c.type === "midpoint") {
      tied.add(key(c.e, c.p));
    }
  }
  return tied;
}

/** The loose ends of a sketch. `tolMm` is the reach an end has to another curve,
 *  the sketcher passes its snap reach so the dots agree with what a snap would join. */
export function looseEnds(
  entities: readonly ResolvedEntity[],
  constraints: readonly SketchConstraint[],
  tolMm: number,
): LooseEnds {
  const profile = entities.filter(isProfile);
  const ends: EndRef[] = [];
  const targets: EndRef[] = [];
  for (const e of profile) {
    const mov = new Set(movableEnds(e));
    for (const p of targetEnds(e)) {
      const q = refPoint(e, p);
      if (!q) continue;
      const r = { entity: e.id, p, x: q.x, y: q.y };
      targets.push(r);
      if (mov.has(p)) ends.push(r);
    }
  }
  if (ends.length > LOOSE_ENDS_CAP) return { open: [], untied: [], capped: true };

  const tied = tiedEnds(entities, constraints);
  const byId = new Map(profile.map((e) => [e.id, e]));
  const cell = Math.max(tolMm, 1e-9);
  const cellKey = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const grid = new Map<string, EndRef[]>();
  for (const t of targets) {
    const k = cellKey(t.x, t.y);
    const list = grid.get(k);
    if (list) list.push(t); else grid.set(k, [t]);
  }
  let curves: Curve[] | null = null;
  const curveList = (): Curve[] => {
    curves ??= profile.map((e) => {
      const pts = entityPolyline(e).map((v) => ({ x: v.x, y: v.y }));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of pts) {
        minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
      }
      return { e, pts, minX, minY, maxX, maxY };
    });
    return curves;
  };

  const open: EndRef[] = [];
  const untied: Untied[] = [];
  for (const end of ends) {
    if (tied.has(key(end.entity, end.p))) continue;
    const own = byId.get(end.entity)!;
    let best: EndRef | null = null;
    let bestD = Infinity;
    const cx = Math.floor(end.x / cell), cy = Math.floor(end.y / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const t of grid.get(`${cx + i},${cy + j}`) ?? []) {
          if (t.entity === end.entity && (t.p === end.p || !selfClosable(own))) continue;
          const d = Math.hypot(t.x - end.x, t.y - end.y);
          if (d <= tolMm && d < bestD) { best = t; bestD = d; }
        }
      }
    }
    if (best) {
      untied.push({ ...end, touches: { kind: "end", entity: best.entity, p: best.p }, gap: bestD, tieable: true });
      continue;
    }
    let near: Curve | null = null;
    let nearD = Infinity;
    for (const c of curveList()) {
      if (c.e.id === end.entity) continue;
      if (end.x < c.minX - tolMm || end.x > c.maxX + tolMm || end.y < c.minY - tolMm || end.y > c.maxY + tolMm) continue;
      const d = curveDist(c, end.x, end.y);
      if (d <= tolMm && d < nearD) { near = c; nearD = d; }
    }
    if (near) {
      untied.push({ ...end, touches: { kind: "curve", entity: near.e.id }, gap: nearD, tieable: curveTieable(near.e) });
    } else {
      open.push(end);
    }
  }
  return { open, untied };
}

/** One constraint per tieable untied end: a coincident to the end it touches or a
 *  pointOnCurve onto the curve. A pair seen from both ends, or a ring of ends at one
 *  corner, gets only the constraints that join something new, a redundant one would
 *  over define the solve. */
export function tieConstraints(le: LooseEnds, constraints: readonly SketchConstraint[] = []): SketchConstraint[] {
  const joins = new Joins();
  for (const c of constraints) if (c.type === "coincident") joins.union(key(c.e1, c.p1), key(c.e2, c.p2));
  const out: SketchConstraint[] = [];
  for (const u of le.untied) {
    if (!u.tieable) continue;
    if (u.touches.kind === "end") {
      if (joins.union(key(u.entity, u.p), key(u.touches.entity, u.touches.p))) {
        out.push({ type: "coincident", e1: u.entity, p1: u.p, e2: u.touches.entity, p2: u.touches.p });
      }
    } else {
      out.push({ type: "pointOnCurve", e: u.entity, p: u.p, curve: u.touches.entity });
    }
  }
  return out;
}

/** The reach used where there is no view to measure a snap in (a closed sketch,
 *  the MCP server): 1% of the profile's size, about 10 px when the sketch fills
 *  the view, never under a micron. */
export function defaultReach(entities: readonly ResolvedEntity[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    if (!isProfile(e)) continue;
    for (const v of entityPolyline(e)) {
      minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
      maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
    }
  }
  const diag = Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
  return Math.max(1e-3, 0.01 * diag);
}
