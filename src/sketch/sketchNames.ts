// The words a screen reader and the lists use for sketch rows. Pure, so a row reads the same wherever it shows.

import type { RelationRow } from "./relations";
import type { ResolvedEntity } from "./snap";
import { freedomWords, type Freedom } from "./freedomWords";

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
export function entityLabel(ents: readonly ResolvedEntity[], id: string): string | null {
  return entityLabeller(ents)(id);
}

/** One pass over the list, so naming every shape of a big sketch is not quadratic. */
export function entityLabeller(ents: readonly ResolvedEntity[]): (id: string) => string | null {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const e of ents) {
    const n = (counts.get(e.type) ?? 0) + 1;
    counts.set(e.type, n);
    if (!names.has(e.id)) names.set(e.id, `${KIND_NAME[e.type] ?? e.type} ${n}`);
  }
  const label = (id: string): string | null => {
    const t = id.indexOf("~");
    if (t < 0) return names.get(id) ?? null;
    const base = label(id.slice(0, t));
    const k = Number(id.slice(t + 1));
    return base && Number.isInteger(k) ? `${base} edge ${k + 1}` : base;
  };
  return label;
}

export type StateWord = "conflicting" | "redundant" | "reference" | "implied";

export function stateWord(r: Pick<RelationRow, "state" | "driven" | "implied">): StateWord | undefined {
  if (r.implied) return "implied";
  if (r.state === "conflict") return "conflicting";
  if (r.state === "over") return "redundant";
  if (r.driven) return "reference";
  return undefined;
}

/** "Distance 12.5 mm, Line 1 and Line 3, conflicting". A reference value drops its brackets, the state says it. */
export function relationName(
  r: Pick<RelationRow, "name" | "value" | "detail" | "state" | "driven" | "implied">,
): string {
  const value = r.value ? ` ${r.value.replace(/^\((.*)\)$/, "$1")}` : "";
  return [`${r.name}${value}`, r.detail, stateWord(r)].filter(Boolean).join(", ");
}

/** A name that repeats gets ", row N" (1 based place in the list), so no two rows read alike. */
export function distinctNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return names.map((n, i) => ((seen.get(n) ?? 0) > 1 ? `${n}, row ${i + 1}` : n));
}

/** "Width of Rectangle 1". */
export function entityDimName(label: string, subject: string | null): string {
  return subject ? `${label} of ${subject}` : label;
}

/** One distinct operand reads "Radius of Arc 1", more "Distance between Line 1 and Line 3" or "between A, B and C". */
export function constraintDimName(face: string, operands: readonly string[]): string {
  const subjects = [...new Set(operands)];
  if (subjects.length === 0) return face;
  if (subjects.length === 1) return `${face} of ${subjects[0]}`;
  const last = subjects[subjects.length - 1];
  return `${face} between ${subjects.slice(0, -1).join(", ")} and ${last}`;
}

/** The subject a dimension row is about, so it keeps its place when a rectangle side turns into a constraint. */
export function dimKey(standsFor: string | null, id: string | undefined, cIndex: number): string {
  return standsFor ?? `c:${id ?? `#${cIndex}`}`;
}

export interface ShapeRow {
  id: string;
  label: string;
  hint: string;
  spoken: string;
}

/** "Line 3, construction, free in X": the label first, then what is worth knowing, with no word for unknown freedom. */
export function shapeRow(
  labelOf: (id: string) => string | null,
  e: ResolvedEntity,
  freedom: Freedom | undefined,
): ShapeRow {
  const label = labelOf(e.id) ?? e.id;
  const facts = [e.type !== "projected" && e.construction ? "construction" : "", freedomWords(freedom)].filter(Boolean);
  return { id: e.id, label, hint: facts.join(" · "), spoken: [label, ...facts].join(", ") };
}
