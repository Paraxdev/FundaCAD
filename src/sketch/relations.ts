// The sketch's relations as a LIST: every constraint on it in one place, what
// each one references, and what the solver makes of it.
//
// The canvas shows constraints as glyphs pinned to the geometry they act on,
// which is the right way to answer "what is holding THIS line down". It is the
// wrong way to answer "what is holding this sketch down", and that is the
// question somebody asks when a sketch will not move the way they expect. A
// glyph you cannot find is indistinguishable from a glyph that is not there; a
// sketch with no constraints at all looks exactly like one whose glyphs are off
// screen; and a relation the solver DERIVED rather than one somebody drew has
// no glyph to look for in the first place.
//
// That last one is the interesting case here. Two endpoints at the same
// position compile to one solver point (sketchSolve's coincKey merge), so a
// chain drawn end to end is genuinely joined with nothing recorded anywhere —
// the corner holds, and there is no constraint, no glyph, and nothing in the
// saved file to say so. Those are listed below as IMPLIED: real, load-bearing,
// and not deletable, because there is no record to delete. Writing coincident
// constraints for them instead would be redundant with the merge, which is
// what the over-defined diagnosis is for (tests/sketch/coincidence.test.ts
// measures all three cases in degrees of freedom).
//
// Pure: entities and constraints in, rows out. No DOM, no store, no viewport.

import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { isDriven } from "../types";
import { coincKey } from "./sketchSolve";
import { constraintFace, diagnosisOf, type ConstraintDiagnosis } from "./glyphs";
import { fmtDim } from "./annotationFormat";

export { constraintFace } from "./glyphs";

/** One line of the relations list. */
export interface RelationRow {
  /** Index into the constraint array, and so the delete target. Null for an
   *  implied relation, which has no record behind it to remove. */
  index: number | null;
  /** The same character the canvas glyph uses, so the two never disagree about
   *  what a constraint looks like. */
  symbol: string;
  /** What it is called, in the words the ribbon buttons use. */
  name: string;
  /** What it acts on: "Line 1 and Line 3". Empty when it acts on nothing that
   *  still exists. */
  detail: string;
  /** The driving value, formatted, for the dimensional constraints. */
  value?: string;
  /** Entity ids to light up while the row is hovered. */
  entities: string[];
  state: ConstraintDiagnosis | null;
  /** A reference dimension: measured, not driving. */
  driven?: true;
  /** Derived from position rather than recorded. Not deletable. */
  implied?: true;
}

/** Degrees, not millimetres — the one dimensional constraint measured in them. */
const isAngle = (c: SketchConstraint) => c.type === "angle";

const KIND_NAME: Record<string, string> = {
  line: "Line", rectangle: "Rectangle", circle: "Circle", arc: "Arc",
  spline: "Spline", point: "Point", polygon: "Polygon", slot: "Slot",
  text: "Text", projected: "Reference",
};

/** What to call an entity in a sentence: its kind plus its position among the
 *  others of that kind, which is the only handle a sketch entity has — they
 *  carry ids, not names. Decodes the compound rectangle-edge operand form.
 *  Returns null for an id nothing answers to, so a stale constraint reads as
 *  acting on nothing rather than on "undefined". */
export function entityLabel(ents: ResolvedEntity[], id: string): string | null {
  const t = id.indexOf("~");
  if (t >= 0) {
    const base = entityLabel(ents, id.slice(0, t));
    const k = Number(id.slice(t + 1));
    return base && Number.isInteger(k) ? `${base} edge ${k + 1}` : base;
  }
  const target = ents.find((e) => e.id === id);
  if (!target) return null;
  let n = 0;
  for (const e of ents) {
    if (e.type === target.type) n++;
    if (e.id === id) break;
  }
  return `${KIND_NAME[target.type] ?? target.type} ${n}`;
}

/** Endpoints that sit on top of each other, and so compile to one solver point.
 *
 *  The same key the solver merges on, deliberately: a list that used its own
 *  idea of "attached" would show joins the solver does not hold and miss ones
 *  it does. Only groups of two or more count — a lone endpoint is not a join. */
export function impliedJoins(ents: ResolvedEntity[]): RelationRow[] {
  const at = new Map<string, string[]>();
  const add = (x: number, y: number, id: string) => {
    const k = coincKey(x, y);
    const list = at.get(k);
    if (list) { if (!list.includes(id)) list.push(id); } else at.set(k, [id]);
  };
  for (const e of ents) {
    if (e.construction) continue;
    if (e.type === "line" || e.type === "arc") {
      add(e.x1, e.y1, e.id);
      add(e.x2, e.y2, e.id);
    } else if (e.type === "spline") {
      const a = e.points[0], b = e.points[e.points.length - 1];
      if (a) add(a.x, a.y, e.id);
      if (b) add(b.x, b.y, e.id);
    } else if (e.type === "point") {
      add(e.x, e.y, e.id);
    }
  }
  const out: RelationRow[] = [];
  for (const ids of at.values()) {
    if (ids.length < 2) continue;
    out.push({
      index: null,
      symbol: "⊙",
      name: "Coincident",
      detail: ids.map((id) => entityLabel(ents, id)).filter(Boolean).join(" and "),
      entities: ids,
      state: null,
      implied: true,
    });
  }
  return out;
}

/** Every recorded constraint on the sketch, in the order they were added. */
export function constraintRows(
  ents: ResolvedEntity[],
  constraints: SketchConstraint[],
  conflicts: Set<number>,
  over: Set<number>,
): RelationRow[] {
  return constraints.map((c, i) => {
    const face = constraintFace(c);
    const labels = face.operands.map((o) => entityLabel(ents, o)).filter((s): s is string => !!s);
    const v = (c as { value?: number }).value;
    const driven = isDriven(c);
    const row: RelationRow = {
      index: i,
      symbol: face.symbol,
      name: face.name,
      detail: labels.join(" and "),
      entities: face.operands.map((o) => o.split("~")[0] ?? o),
      state: diagnosisOf(i, conflicts, over),
    };
    if (typeof v === "number") row.value = fmtDim(v, isAngle(c) ? "angle" : "length", driven);
    if (driven) row.driven = true;
    return row;
  });
}

/** The whole list: what was drawn, then what the geometry implies. */
export function relationRows(
  ents: ResolvedEntity[],
  constraints: SketchConstraint[],
  conflicts: Set<number>,
  over: Set<number>,
): RelationRow[] {
  return [...constraintRows(ents, constraints, conflicts, over), ...impliedJoins(ents)];
}

/** How the degrees-of-freedom count reads to a person.
 *
 *  `dof < 0` is "no solve has run", which is the state a sketch with no
 *  constraints stays in — it is not the same as zero, and reporting it as
 *  "fully defined" would be exactly backwards. */
export function dofSummary(dof: number, conflict: boolean): string {
  if (conflict) return "Conflicting constraints";
  if (dof < 0) return "Not constrained";
  if (dof === 0) return "Fully defined";
  return `${dof} degree${dof === 1 ? "" : "s"} of freedom`;
}
