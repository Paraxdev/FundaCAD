// What a line being drawn will be recorded with, worked out BEFORE the click so
// the preview, the glyphs beside the cursor and the committed constraints are
// the same answer. Pure: SketchMode feeds it the snap result and the sketch.

import * as THREE from "three";
import type { SketchConstraint } from "../types";
import { asRound } from "./entityDims";
import { inferLineDirection, onLattice } from "./inferLine";
import type { ResolvedEntity, SnapKind, SnapRef } from "./snap";

export interface InferLineInput {
  /** Id the new line will carry, so the relations can name it. */
  id: string;
  start: THREE.Vector2;
  startRef?: SnapRef | null | undefined;
  /** The snapped cursor, and the raw one the direction guesses read. */
  end: THREE.Vector2;
  raw?: THREE.Vector2 | undefined;
  endKind: SnapKind;
  endRef?: SnapRef | null | undefined;
  entities: readonly ResolvedEntity[];
  /** Live grid lattice, 0 when grid snapping is off. */
  step: number;
  tolDeg: number;
  /** How far, in mm, a line may be from the start or the cursor and still be
   *  offered as a parallel or perpendicular reference. */
  nearMm: number;
  /** The Snap toggle: off leaves only the exact horizontal and vertical rules. */
  smart: boolean;
  typedAngle?: boolean;
}

export interface InferResult {
  end: THREE.Vector2;
  relations: SketchConstraint[];
  /** Icon names, one per relation, for the tag beside the cursor. */
  glyphs: string[];
  /** Dashed hint segments, the line a parallel or perpendicular is taken from. */
  hints: [THREE.Vector2, THREE.Vector2][];
}

const ANCHORED: ReadonlySet<SnapKind> = new Set(["endpoint", "midpoint", "center", "control", "curve"]);

/** Whether the cursor tag names a relation: the join at the start of a line is
 *  already drawn, so the tag only names what the end takes. */
export const tagged = (c: SketchConstraint) => !(c.type === "coincident" && c.p1 === 0);

function glyphOf(c: SketchConstraint): string {
  switch (c.type) {
    case "pointOnCurve": return "coincident";
    case "tangent2": return "tangent";
    default: return c.type;
  }
}

/** Unit direction leaving endpoint `at` (0 start, 1 end) INTO the curve. */
export function leaveDirection(e: ResolvedEntity, at: number): THREE.Vector2 | null {
  if (e.type === "line") {
    const d = at === 0 ? new THREE.Vector2(e.x2 - e.x1, e.y2 - e.y1) : new THREE.Vector2(e.x1 - e.x2, e.y1 - e.y2);
    return d.lengthSq() > 1e-18 ? d.normalize() : null;
  }
  if (e.type === "arc") {
    const r = asRound(e);
    if (!r) return null;
    const ccw = (e.mx - e.x1) * (e.y2 - e.my) - (e.my - e.y1) * (e.x2 - e.mx) > 0;
    const px = at === 0 ? e.x1 : e.x2, py = at === 0 ? e.y1 : e.y2;
    // travel direction a -> m -> b at that point
    const t = ccw ? new THREE.Vector2(-(py - r.y), px - r.x) : new THREE.Vector2(py - r.y, -(px - r.x));
    if (t.lengthSq() < 1e-18) return null;
    t.normalize();
    return at === 0 ? t : t.negate();
  }
  return null;
}

/** The angle in degrees between two directions, 0..180. */
function angleBetween(a: THREE.Vector2, b: THREE.Vector2): number {
  return (Math.atan2(Math.abs(a.x * b.y - a.y * b.x), a.x * b.x + a.y * b.y) * 180) / Math.PI;
}

function along(start: THREE.Vector2, dir: THREE.Vector2, q: THREE.Vector2): THREE.Vector2 {
  const t = (q.x - start.x) * dir.x + (q.y - start.y) * dir.y;
  return new THREE.Vector2(start.x + dir.x * t, start.y + dir.y * t);
}

/** A point relation for an endpoint that snapped to a point, a midpoint or onto a curve. */
export function pointRelation(id: string, p: number, ref: SnapRef | null | undefined, entities: readonly ResolvedEntity[]): SketchConstraint | null {
  if (!ref || ref.entity === id) return null;
  const target = entities.find((e) => e.id === ref.entity);
  if (!target) return null;
  if (typeof ref.at === "number") return { type: "coincident", e1: id, p1: p, e2: target.id, p2: ref.at };
  if (ref.at === "mid" && target.type === "line") return { type: "midpoint", e: id, p, line: target.id };
  if (ref.at === "curve" && (target.type === "line" || target.type === "circle" || target.type === "arc")) {
    return { type: "pointOnCurve", e: id, p, curve: target.id };
  }
  return null;
}

/** The tangent continuation of a curve ending at `ref`, as a relation and the
 *  direction a new curve leaving that point has to take. */
export function tangentFrom(id: string, ref: SnapRef | null | undefined, entities: readonly ResolvedEntity[]): { dir: THREE.Vector2; relation: SketchConstraint } | null {
  if (!ref || typeof ref.at !== "number" || ref.at > 1 || ref.entity === id) return null;
  const prev = entities.find((e) => e.id === ref.entity);
  if (!prev || (prev.type !== "line" && prev.type !== "arc")) return null;
  const leave = leaveDirection(prev, ref.at);
  if (!leave) return null;
  // A line continuing a line is collinear: planegcs has no line-line tangent.
  const relation: SketchConstraint = prev.type === "line"
    ? { type: "collinear", l1: prev.id, l2: id }
    : { type: "tangent2", a: id, b: prev.id };
  return { dir: leave.negate(), relation };
}

/** Within this a lattice end counts as lying on a guessed direction. */
const EXACT_DEG = 1e-6;

function distToSegment(q: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.min(1, Math.max(0, q.clone().sub(a).dot(ab) / l2)) : 0;
  return q.distanceTo(a.clone().addScaledVector(ab, t));
}

/** Tangent continuation of the curve the line starts on, else parallel or
 *  perpendicular to a line within `nearMm` of the start or the cursor. */
function guessDirection(
  id: string, start: THREE.Vector2, cursor: THREE.Vector2, draw: THREE.Vector2,
  startRef: SnapRef | null | undefined, entities: readonly ResolvedEntity[], tol: number, nearMm: number,
): { dir: THREE.Vector2; relation: SketchConstraint; hint?: [THREE.Vector2, THREE.Vector2] } | null {
  const tan = tangentFrom(id, startRef, entities);
  if (tan && angleBetween(draw, tan.dir) <= tol) return tan;
  let bestErr = tol, pick: { a: THREE.Vector2; b: THREE.Vector2; lineId: string; dir: THREE.Vector2; kind: "parallel" | "perpendicular" } | null = null;
  for (const e of entities) {
    if (e.type !== "line" || e.id === id) continue;
    const a = new THREE.Vector2(e.x1, e.y1), b = new THREE.Vector2(e.x2, e.y2);
    if (Math.min(distToSegment(start, a, b), distToSegment(cursor, a, b)) > nearMm) continue;
    const d = b.clone().sub(a);
    if (d.lengthSq() < 1e-18) continue;
    d.normalize();
    const n = new THREE.Vector2(-d.y, d.x);
    for (const [kind, dir] of [["parallel", d], ["perpendicular", n]] as const) {
      const err = Math.min(angleBetween(draw, dir), 180 - angleBetween(draw, dir));
      if (err <= bestErr) { bestErr = err; pick = { a, b, lineId: e.id, dir, kind }; }
    }
  }
  if (!pick) return null;
  return { dir: pick.dir, relation: { type: pick.kind, l1: pick.lineId, l2: id }, hint: [pick.a, pick.b] };
}

export function inferLineRelations(inp: InferLineInput): InferResult {
  const { id, start, entities, smart } = inp;
  let end = inp.end.clone();
  const relations: SketchConstraint[] = [];
  const hints: [THREE.Vector2, THREE.Vector2][] = [];

  if (smart) {
    const r0 = pointRelation(id, 0, inp.startRef, entities);
    if (r0) relations.push(r0);
  }
  const anchored = !!inp.endRef || ANCHORED.has(inp.endKind);
  if (smart && anchored) {
    const r1 = pointRelation(id, 1, inp.endRef, entities);
    if (r1) relations.push(r1);
  }

  if (!inp.typedAngle) {
    const tol = anchored ? 0 : inp.tolDeg;
    const hv = inferLineDirection(start.x, start.y, end.x, end.y, inp.step, tol);
    if (hv) {
      if (hv === "horizontal") end.y = start.y;
      else end.x = start.x;
      relations.push({ type: hv, line: id });
    } else if (smart && !anchored && tol > 0) {
      // A lattice end is the user's choice: a guess may only name a direction
      // the snapped end already lies on, never move it off the lattice.
      const gridded = inp.step > 0 && [start.x, start.y, end.x, end.y].every((v) => onLattice(v, inp.step));
      const raw = gridded ? end.clone() : (inp.raw ?? end);
      const draw = raw.clone().sub(start);
      const within = gridded ? EXACT_DEG : tol;
      if (draw.lengthSq() > 1e-12) {
        const guess = guessDirection(id, start, raw, draw, inp.startRef, entities, within, inp.nearMm);
        if (guess) {
          if (!gridded) end = along(start, guess.dir, raw);
          relations.push(guess.relation);
          if (guess.hint) hints.push(guess.hint);
        }
      }
    }
  }

  return { end, relations, glyphs: relations.filter(tagged).map(glyphOf), hints };
}

/** The arc from `a` leaving along unit `dir` that ends at `b`, as a 3-point arc's
 *  mid point, or null when `b` lies straight ahead (no arc fits). */
export function tangentArcMid(a: THREE.Vector2, dir: THREE.Vector2, b: THREE.Vector2): THREE.Vector2 | null {
  const n = new THREE.Vector2(-dir.y, dir.x);
  const ab = b.clone().sub(a);
  const den = 2 * n.dot(ab);
  if (Math.abs(den) < 1e-9 * Math.max(1, ab.lengthSq())) return null;
  const k = ab.lengthSq() / den;
  const c = a.clone().addScaledVector(n, k);
  const r = Math.abs(k);
  const tau = 2 * Math.PI;
  const ta = Math.atan2(a.y - c.y, a.x - c.x), tb = Math.atan2(b.y - c.y, b.x - c.x);
  // centre on the left of the travel direction turns counterclockwise
  const sweep = k > 0 ? (((tb - ta) % tau) + tau) % tau : -((((ta - tb) % tau) + tau) % tau);
  const tm = ta + sweep / 2;
  return new THREE.Vector2(c.x + r * Math.cos(tm), c.y + r * Math.sin(tm));
}

/** Relations for an arc a -> m -> b whose ends snapped to `refA`/`refB`: a point
 *  relation for a midpoint or on-curve end, and a tangent2 where the arc leaves
 *  an existing line or arc end within `tolDeg` of its direction. A tangent start
 *  bends the arc to be exactly tangent, so the first solve has nothing to move. */
export function inferArcRelations(
  id: string, arc: { x1: number; y1: number; x2: number; y2: number; mx: number; my: number },
  refA: SnapRef | null | undefined, refB: SnapRef | null | undefined,
  entities: readonly ResolvedEntity[], tolDeg: number, smart: boolean,
): { mid: THREE.Vector2; relations: SketchConstraint[] } {
  const mid = new THREE.Vector2(arc.mx, arc.my);
  if (!smart) return { mid, relations: [] };
  const out: SketchConstraint[] = [];
  const a = new THREE.Vector2(arc.x1, arc.y1), b = new THREE.Vector2(arc.x2, arc.y2);
  for (const [at, ref] of [[0, refA], [1, refB]] as const) {
    const pr = pointRelation(id, at, ref, entities);
    if (pr) out.push(pr);
    if (pr && pr.type !== "coincident") continue;
    const tan = tangentFrom(id, ref, entities);
    const mine = leaveDirection({ type: "arc", id, ...arc, mx: mid.x, my: mid.y }, at);
    if (!tan || !mine || angleBetween(mine, tan.dir) > tolDeg) continue;
    if (at === 0) {
      const m = tangentArcMid(a, tan.dir, b);
      if (!m) continue;
      mid.copy(m);
    }
    out.push(tan.relation.type === "collinear" ? { type: "tangent2", a: id, b: ref!.entity } : tan.relation);
  }
  return { mid, relations: out };
}

/** Stand-in id for the entity being drawn, before it has one. */
export const NEW_ENTITY = "__new__";

/** `cs` with every NEW_ENTITY operand renamed to `id`. */
export function bindNew(cs: readonly SketchConstraint[], id: string): SketchConstraint[] {
  return cs.map((c) => {
    const out: Record<string, unknown> = { ...c };
    for (const k of Object.keys(out)) if (out[k] === NEW_ENTITY) out[k] = id;
    return out as SketchConstraint;
  });
}
