// What the two panels show, worked out from a document with no DOM, so the rules
// are testable in the node suite: which parameters a person tunes, in which
// group, through which control, and what a typed list of choices means.

import { controlProblem } from "fundacad";
import type { CadDocument, ParamControl, ParamDef } from "fundacad";

export interface TuneRow {
  name: string;
  def: ParamDef;
  control: ParamControl;
  /** false when the value is a formula over other parameters: a control would
   *  overwrite the formula with a number, so the row only reports it. */
  editable: boolean;
  problem: string | null;
  unit: string;
}

export interface TuneGroup {
  /** null for the parameters in no group. */
  id: string | null;
  name: string;
  rows: TuneRow[];
}

/** A literal number, the only kind of value a control can own. */
export function isPlainNumber(expr: string): boolean {
  const t = expr.trim();
  return t !== "" && Number.isFinite(Number(t));
}

export function unitLabel(def: ParamDef): string {
  return def.unit === "mm" ? "mm" : def.unit === "deg" ? "°" : "";
}

/** The user parameters, grouped in the document's group order with the
 *  ungrouped ones first. Model parameters (bound to one field) and hidden
 *  helpers are left out: this is the list of knobs, not the table. */
export function tuneGroups(doc: CadDocument): TuneGroup[] {
  const defs = doc.paramDefs ?? {};
  const groups = doc.paramExtras?.groups ?? [];
  const known = new Set(groups.map((g) => g.id));
  const rowsIn = (id: string | null): TuneRow[] =>
    Object.entries(defs)
      .filter(([, d]) => !d.target && !d.hidden)
      .filter(([, d]) => (id === null ? d.group === undefined || !known.has(d.group) : d.group === id))
      .map(([name, def]) => ({
        name,
        def,
        control: def.control ?? { kind: "number" },
        editable: isPlainNumber(def.expr),
        problem: controlProblem(def),
        unit: unitLabel(def),
      }));
  const out: TuneGroup[] = [];
  const loose = rowsIn(null);
  if (loose.length) out.push({ id: null, name: "", rows: loose });
  for (const g of groups) {
    const rows = rowsIn(g.id);
    if (rows.length) out.push({ id: g.id, name: g.name, rows });
  }
  return out;
}

/** "Small = 10, Large = 30" as choices. A bare number is its own label. Returns
 *  an error rather than guessing when an entry has no number in it. */
export function parseChoices(text: string): { label: string; value: number }[] | string {
  const out: { label: string; value: number }[] = [];
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.lastIndexOf("=");
    const label = eq >= 0 ? part.slice(0, eq).trim() : part;
    const value = Number(eq >= 0 ? part.slice(eq + 1).trim() : part);
    if (!Number.isFinite(value)) return `"${part}" needs a number, like Large = 30`;
    out.push({ label: label || String(value), value });
  }
  return out.length ? out : "list at least one choice";
}

export function formatChoices(choices: { label: string; value: number }[]): string {
  return choices.map((c) => (c.label === String(c.value) ? String(c.value) : `${c.label} = ${c.value}`)).join(", ");
}

/** The next free id with a prefix, `g1`, `g2`, over the ids already in use. */
export function nextId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A control of another kind, carrying over whatever range still applies, so
 *  flipping a slider to a number box and back does not lose its limits. */
export function convertControl(from: ParamControl | undefined, kind: ParamControl["kind"], value: number): ParamControl {
  const range = from && (from.kind === "number" || from.kind === "slider") ? from : undefined;
  switch (kind) {
    case "toggle":
      return { kind };
    case "choice":
      return { kind, choices: from?.kind === "choice" ? from.choices : [{ label: String(value), value }] };
    case "slider":
      return {
        kind,
        min: range?.min ?? Math.min(0, value),
        max: range?.max ?? Math.max(1, value * 2),
        ...(range?.step !== undefined ? { step: range.step } : {}),
      };
    case "number":
      return {
        kind,
        ...(range?.min !== undefined ? { min: range.min } : {}),
        ...(range?.max !== undefined ? { max: range.max } : {}),
        ...(range?.step !== undefined ? { step: range.step } : {}),
      };
  }
}
