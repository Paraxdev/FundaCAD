// Evaluation over `paramExtras` and the per-parameter controls: which checks
// fail, what a value clamps to, what a configuration would change. Pure, so the
// store's commits and the FundaCAD.ExtraParameters panels agree by construction.
// Nothing here writes a document; engine.ts owns rename/delete through extras.

import type { CadDocument, ParamCheck, ParamConfiguration, ParamControl, ParamDef, ParamExtras } from "../types";
import { evalExpr } from "./eval";
import { ExprError } from "./parse";
import { commitParamExpr, defsOf, recompute, validateExpr } from "./engine";

export interface CheckResult {
  check: ParamCheck;
  /** true when the rule holds. */
  ok: boolean;
  /** set when the rule could not be evaluated at all, which also counts as not ok. */
  error?: string;
}

function valuesOf(doc: CadDocument): Record<string, number> {
  return Object.fromEntries(Object.entries(defsOf(doc)).map(([n, d]) => [n, d.value]));
}

export function checkResults(doc: CadDocument): CheckResult[] {
  const values = valuesOf(doc);
  return (doc.paramExtras?.checks ?? []).map((check) => {
    try {
      const v = evalExpr(check.expr, values);
      if (Number.isNaN(v)) return { check, ok: false, error: "does not evaluate to a number" };
      return { check, ok: v !== 0 };
    } catch (e) {
      return { check, ok: false, error: e instanceof ExprError ? e.message : String(e) };
    }
  });
}

/** Where a control keeps a value: inside min/max, on a step counted from min,
 *  0 or 1 for a toggle, and the nearest listed value for a choice. */
export function clampToControl(control: ParamControl | undefined, value: number): number {
  if (!control || !Number.isFinite(value)) return value;
  switch (control.kind) {
    case "toggle":
      return value !== 0 ? 1 : 0;
    case "choice": {
      let best = value;
      let dist = Infinity;
      for (const c of control.choices) {
        const d = Math.abs(c.value - value);
        if (d < dist) [best, dist] = [c.value, d];
      }
      return best;
    }
    case "number":
    case "slider": {
      let v = value;
      if (control.step && control.step > 0) {
        const base = control.min ?? 0;
        v = base + Math.round((v - base) / control.step) * control.step;
        v = Number(v.toFixed(10)); // float drift from the step arithmetic, not a real digit
      }
      if (control.min !== undefined) v = Math.max(control.min, v);
      if (control.max !== undefined) v = Math.min(control.max, v);
      return v;
    }
  }
}

/** Why a parameter's current value sits outside its own control, or null. A
 *  value typed as an expression can land out of range without passing the
 *  control, so the panel reports it rather than silently rewriting it. */
export function controlProblem(def: ParamDef): string | null {
  const c = def.control;
  if (!c) return null;
  const clamped = clampToControl(c, def.value);
  if (Math.abs(clamped - def.value) <= 1e-9 * Math.max(1, Math.abs(def.value))) return null;
  switch (c.kind) {
    case "toggle":
      return "a toggle is 0 or 1";
    case "choice":
      return "not one of the listed choices";
    default:
      if (c.min !== undefined && def.value < c.min) return `below the minimum of ${c.min}`;
      if (c.max !== undefined && def.value > c.max) return `above the maximum of ${c.max}`;
      return `not on a step of ${c.step}`;
  }
}

/** The user parameters as they are now, as a configuration. Model parameters
 *  (the auto-named d1, d2 bound to one field) are left out: they belong to a
 *  feature, and a variant of the design is a choice of its named inputs. */
export function captureConfiguration(doc: CadDocument, id: string, name: string): ParamConfiguration {
  const values: Record<string, string> = {};
  for (const [n, def] of Object.entries(defsOf(doc))) {
    if (!def.target) values[n] = def.expr;
  }
  return { id, name, values };
}

/** Apply a configuration to a COPY of the document, one value at a time so a
 *  value may read one set before it. The error names the first value that does
 *  not fit, and nothing is applied then. */
export function trialConfiguration(doc: CadDocument, cfg: ParamConfiguration): { ok: true; doc: CadDocument } | { ok: false; error: string } {
  const draft = structuredClone(doc);
  const defs = defsOf(draft);
  for (const [name, expr] of Object.entries(cfg.values)) {
    if (!(name in defs)) return { ok: false, error: `${cfg.name}: there is no parameter "${name}" any more` };
    const v = validateExpr(draft, name, expr);
    if (!v.ok) return { ok: false, error: `${cfg.name}: ${name} = ${expr}: ${v.error}` };
    commitParamExpr(draft, name, expr);
    recompute(draft);
  }
  return { ok: true, doc: draft };
}

/** Parameter names whose expression differs from what the configuration sets. */
export function configurationDrift(doc: CadDocument, cfg: ParamConfiguration): string[] {
  const defs = defsOf(doc);
  return Object.entries(cfg.values)
    .filter(([name, expr]) => defs[name]?.expr.replace(/\s+/g, "") !== expr.replace(/\s+/g, ""))
    .map(([name]) => name);
}

/** True when the block carries nothing, so it can be dropped from the file. */
export function extrasEmpty(x: ParamExtras): boolean {
  return !x.groups?.length && !x.configurations?.length && !x.checks?.length && x.activeConfiguration === undefined;
}
