// The sketch's relations as a list, including IMPLIED joins: endpoints at one position compile to one solver point
// (sketchSolve's coincKey merge), a real join with no record, glyph or saved trace, so it is listed but not deletable.

import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { isDriven } from "../types";
import { coincKey } from "./sketchSolve";
import { constraintFace, diagnosisOf, type ConstraintDiagnosis } from "./glyphs";
import { fmtDim } from "./annotationFormat";

export { constraintFace } from "./glyphs";

export interface RelationRow {
  /** Null for an implied relation, which has no record to delete. */
  index: number | null;
  /** The canvas glyph's icon, so the two never disagree. */
  icon: string;
  /** In the words the ribbon buttons use. */
  name: string;
  /** "Line 1 and Line 3", empty when it acts on nothing that still exists. */
  detail: string;
  /** Only on dimensional constraints. */
  value?: string;
  /** Lit while the row is hovered. */
  entities: string[];
  state: ConstraintDiagnosis | null;
  /** A reference dimension: measured, not driving. */
  driven?: true;
  /** Derived from position rather than recorded. Not deletable. */
  implied?: true;
}

/** Degrees, not millimetres, the one dimensional constraint measured in them. */
const isAngle = (c: SketchConstraint) => c.type === "angle";

const KIND_NAME: Record<string, string> = {
  line: "Line",
  rectangle: "Rectangle",
  circle: "Circle",
  arc: "Arc",
  spline: "Spline",
  bspline: "Control point spline",
  point: "Point",
  polygon: "Polygon",
  slot: "Slot",
  text: "Text",
  projected: "Reference",
};

/** Kind plus position among its kind, the only handle an entity has (ids, not names). Decodes rect-edge operands,
 *  null for an id nothing answers to, so a stale constraint reads as acting on nothing. */
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

/** Endpoints that compile to one solver point. Uses the solver's own merge key on purpose, so the list never shows
 *  joins the solver does not hold. A lone endpoint is not a join. */
export function impliedJoins(ents: ResolvedEntity[], recorded: readonly SketchConstraint[] = []): RelationRow[] {
  const at = new Map<string, string[]>();
  const add = (x: number, y: number, id: string) => {
    const k = coincKey(x, y);
    const list = at.get(k);
    if (list) {
      if (!list.includes(id)) list.push(id);
    } else at.set(k, [id]);
  };
  for (const e of ents) {
    if (e.construction) continue;
    if (e.type === "line" || e.type === "arc") {
      add(e.x1, e.y1, e.id);
      add(e.x2, e.y2, e.id);
    } else if (e.type === "spline") {
      const a = e.points[0],
        b = e.points[e.points.length - 1];
      if (a) add(a.x, a.y, e.id);
      if (b) add(b.x, b.y, e.id);
    } else if (e.type === "bspline" && !e.closed) {
      const a = e.poles[0],
        b = e.poles[e.poles.length - 1];
      if (a) add(a.x, a.y, e.id);
      if (b) add(b.x, b.y, e.id);
    } else if (e.type === "point") {
      add(e.x, e.y, e.id);
    }
  }
  const out: RelationRow[] = [];
  for (const ids of at.values()) {
    if (ids.length < 2 || joinedByRecords(ids, recorded)) continue;
    out.push({
      index: null,
      icon: "coincident",
      name: "Coincident",
      detail: ids
        .map((id) => entityLabel(ents, id))
        .filter(Boolean)
        .join(" and "),
      entities: ids,
      state: null,
      implied: true,
    });
  }
  return out;
}

/** Whether recorded coincidents between these ids already tie all of them together. */
function joinedByRecords(ids: string[], recorded: readonly SketchConstraint[]): boolean {
  const reached = new Set([ids[0]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of recorded) {
      if (c.type !== "coincident" || !ids.includes(c.e1) || !ids.includes(c.e2)) continue;
      if (reached.has(c.e1) !== reached.has(c.e2)) {
        reached.add(c.e1);
        reached.add(c.e2);
        grew = true;
      }
    }
  }
  return ids.every((id) => reached.has(id));
}

/** In the order they were added. */
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
      icon: face.icon,
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

/** What was drawn, then what the geometry implies. */
export function relationRows(
  ents: ResolvedEntity[],
  constraints: SketchConstraint[],
  conflicts: Set<number>,
  over: Set<number>,
): RelationRow[] {
  return [...constraintRows(ents, constraints, conflicts, over), ...impliedJoins(ents, constraints)];
}

/** `dof < 0` means no solve has run, which a sketch without constraints stays in, and is not "fully defined". */
export function dofSummary(dof: number, conflict: boolean): string {
  if (conflict) return "Conflicting constraints";
  if (dof < 0) return "Not constrained";
  if (dof === 0) return "Fully defined";
  return `${dof} degree${dof === 1 ? "" : "s"} of freedom`;
}
