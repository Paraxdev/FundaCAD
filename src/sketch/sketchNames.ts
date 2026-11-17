// The words a screen reader and the lists use for sketch rows. Pure, so a row reads the same wherever it shows.

import type { RelationRow } from "./relations";
import type { ResolvedEntity } from "./snap";
import { freedomWords, type Freedom } from "./freedomWords";
import { t } from "../i18n";

/** "A and B", or "A, B and C" with `commas`, in the current language. */
export function andWords(parts: readonly string[], commas = false): string {
  if (parts.length < 2) return parts[0] ?? "";
  const last = parts[parts.length - 1]!;
  const head = parts.slice(0, -1);
  const before = commas
    ? head.reduce((a, b) => t("pick.list.more", { before: a, after: b }))
    : head.reduce((a, b) => t("pick.list.last", { before: a, last: b }));
  return t("pick.list.last", { before, last });
}

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
    if (!names.has(e.id)) names.set(e.id, t("sketch.name.entity", { kind: e.type, n }));
  }
  const label = (id: string): string | null => {
    const cut = id.indexOf("~");
    if (cut < 0) return names.get(id) ?? null;
    const base = label(id.slice(0, cut));
    const k = Number(id.slice(cut + 1));
    return base && Number.isInteger(k) ? t("sketch.name.edge", { name: base, n: k + 1 }) : base;
  };
  return label;
}

export type StateWord = "conflicting" | "redundant" | "reference" | "implied";

/** The state as a reader hears it, `StateWord` itself is the id the lists key on. */
export const stateText = (word: StateWord): string => t("sketch.name.state", { word });

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
  const word = stateWord(r);
  return [`${r.name}${value}`, r.detail, word && stateText(word)].filter(Boolean).join(", ");
}

/** A name that repeats gets ", row N" (1 based place in the list), so no two rows read alike. */
export function distinctNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return names.map((n, i) => ((seen.get(n) ?? 0) > 1 ? t("sketch.name.row", { name: n, n: i + 1 }) : n));
}

/** "Width of Rectangle 1". */
export function entityDimName(label: string, subject: string | null): string {
  return subject ? t("sketch.name.of", { label, subject }) : label;
}

/** One distinct operand reads "Radius of Arc 1", more "Distance between Line 1 and Line 3" or "between A, B and C". */
export function constraintDimName(face: string, operands: readonly string[]): string {
  const subjects = [...new Set(operands)];
  if (subjects.length === 0) return face;
  if (subjects.length === 1) return t("sketch.name.of", { label: face, subject: subjects[0]! });
  return t("sketch.name.between", { label: face, subjects: andWords(subjects, true) });
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
  const facts = [
    e.type !== "projected" && e.construction ? t("sketch.name.construction") : "",
    freedomWords(freedom),
  ].filter(Boolean);
  return { id: e.id, label, hint: facts.join(" · "), spoken: [label, ...facts].join(", ") };
}
