// The words a screen reader and the lists use for sketch rows. Pure, so a row reads the same wherever it shows.

import type { RelationRow } from "./relations";

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
