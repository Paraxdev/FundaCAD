// The parameters engine: evaluates paramDefs, writes values into bound fields and owns bind, rename, delete and
// cycle rules. Mutates in place, inside one store.mutate() so an edit and its cascade are one undo step.
// paramDefs is the truth and doc.parameters a derived cache, recompute is the sole writer of bound fields, and a
// broken expression is never committed; load-time breakage keeps its cached value and shows in `issues`.

import { asFeature } from "../types";
import type { CadDocument, ParamDef, ParamTarget } from "../types";
import { ExprError, isIdentName, isNumericLiteral, isReservedName, parseExpr, refsOfNode, renameRefs } from "./parse";
import type { ExprNode } from "./parse";
import { evalNode } from "./eval";
import { kindUnit, NON_NUM_STRING_FIELDS, resolveTarget, writeTarget } from "../document/numFields";
import type { FieldKind } from "../document/numFields";

export interface RecomputeResult {
  /** Sketch ids whose values changed and need a re-solve (live if open, headless cascade if closed). */
  affectedSketches: Set<string>;
  /** param name → why it kept its cached value (cycle, unknown ref, non-finite,
   *  missing target). Empty on a healthy document. */
  issues: Record<string, string>;
}

export function defsOf(doc: CadDocument): Record<string, ParamDef> {
  return (doc.paramDefs ??= {});
}

/** Next free auto model-parameter name (d1, d2, …). */
export function nextDName(defs: Record<string, ParamDef>): string {
  let n = 1;
  for (const name of Object.keys(defs)) {
    const m = /^d(\d+)$/.exec(name);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `d${n}`;
}

/** Parse every def once; an unparsable expression maps to null and surfaces as an issue at evaluation. */
function parseDefs(defs: Record<string, ParamDef>): Map<string, ExprNode | null> {
  const nodes = new Map<string, ExprNode | null>();
  for (const [name, def] of Object.entries(defs)) {
    try {
      nodes.set(name, parseExpr(def.expr));
    } catch {
      nodes.set(name, null);
    }
  }
  return nodes;
}

function refsOf(def: ParamDef, defs: Record<string, ParamDef>): string[] {
  try {
    return extractDefRefs(parseExpr(def.expr), defs);
  } catch {
    return []; // unparsable expr surfaces as an issue during evaluation
  }
}

function extractDefRefs(node: ExprNode | null, defs: Record<string, ParamDef>): string[] {
  return node ? refsOfNode(node).filter((r) => r in defs) : [];
}

/** Re-evaluate the whole table in dependency order, write changed values into
 *  bound fields, refresh the derived `doc.parameters` cache, and drop model
 *  params whose target is gone and that nothing references. */
export function recompute(doc: CadDocument): RecomputeResult {
  const defs = defsOf(doc);
  const issues: Record<string, string> = {};
  const affectedSketches = new Set<string>();
  const nodes = parseDefs(defs);
  // Each def's references, walked once for both GC and topo-sort deps (GC drops only unreferenced defs).
  const refsByName = new Map<string, string[]>();
  for (const [name, node] of nodes) refsByName.set(name, extractDefRefs(node, defs));

  // GC model params whose target was deleted. Unreferenced ones drop silently: an orphan dN means nothing, and
  // undo restores it from the snapshot.
  const referenced = new Set<string>();
  for (const rs of refsByName.values()) for (const r of rs) referenced.add(r);
  for (const [name, def] of Object.entries(defs)) {
    if (def.target && !resolveTarget(doc, def.target)) {
      if (referenced.has(name)) issues[name] = "its dimension or feature no longer exists";
      else {
        delete defs[name];
        nodes.delete(name);
        refsByName.delete(name);
      }
    }
  }

  // Topological order (Kahn); cycle members keep their cached value.
  const names = Object.keys(defs);
  const deps = refsByName;
  const indeg = new Map(names.map((n) => [n, deps.get(n)!.length]));
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const n of names) for (const d of deps.get(n)!) dependents.get(d)!.push(n);
  const order: string[] = [];
  const queue = names.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of dependents.get(n)!) {
      const k = indeg.get(m)! - 1;
      indeg.set(m, k);
      if (k === 0) queue.push(m);
    }
  }
  const inOrder = new Set(order);
  for (const n of names) if (!inOrder.has(n)) issues[n] ??= "circular reference";

  // Every def contributes its value, the cached one when it cannot be evaluated.
  const values: Record<string, number> = {};
  for (const n of names) values[n] = defs[n]!.value; // cycle/error fallback scope
  for (const n of order) {
    const def = defs[n]!;
    const node = nodes.get(n);
    if (!node) {
      issues[n] = "invalid expression";
      continue;
    }
    try {
      const v = evalNode(node, values);
      if (!Number.isFinite(v)) {
        issues[n] = "does not evaluate to a finite number";
      } else {
        def.value = v;
        values[n] = v;
      }
    } catch (e) {
      issues[n] = e instanceof ExprError ? e.message : String(e);
    }
  }

  for (const def of Object.values(defs)) {
    if (!def.target) continue;
    const w = writeTarget(doc, def.target, def.value);
    if (w?.sketch) affectedSketches.add(w.sketch);
  }

  // The derived cache the engine and legacy readers consume.
  doc.parameters = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value]));

  return { affectedSketches, issues };
}

/** Would `expr` under `name` reference `name` back through the table? Returns
 *  the cycle chain for the error message, or null. */
function findCycle(defs: Record<string, ParamDef>, name: string, refs: string[]): string[] | null {
  const seen = new Set<string>();
  const walk = (from: string, path: string[]): string[] | null => {
    if (from === name) return [...path, from];
    if (seen.has(from)) return null;
    seen.add(from);
    const def = defs[from];
    if (!def) return null;
    for (const r of refsOf(def, defs)) {
      const hit = walk(r, [...path, from]);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of refs) {
    const hit = walk(r, [name]);
    if (hit) return hit;
  }
  return null;
}

export type Validation = { ok: true; value: number } | { ok: false; error: string };

/** Strict commit-time validation: parse, known refs, no cycle, finite value,
 *  and no unit suffix when the destination is a count field. Never mutates. */
export function validateExpr(doc: CadDocument, name: string | null, expr: string, kind?: FieldKind): Validation {
  const defs = defsOf(doc);
  let node: ExprNode;
  try {
    node = parseExpr(expr);
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : String(e) };
  }
  const refs = refsOfNode(node);
  for (const r of refs) {
    if (!(r in defs)) return { ok: false, error: `unknown parameter "${r}"` };
    if (r === name) return { ok: false, error: `"${name}" cannot reference itself` };
  }
  if (name) {
    const cycle = findCycle(defs, name, refs);
    if (cycle) return { ok: false, error: `circular reference: ${cycle.join(" → ")}` };
  }
  if (kind === "count" && hasUnitLiteral(node)) {
    return { ok: false, error: "this field is unitless, write a plain number" };
  }
  const values = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value]));
  let value: number;
  try {
    value = evalNode(node, values);
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : String(e) };
  }
  if (!Number.isFinite(value)) return { ok: false, error: "does not evaluate to a finite number" };
  return { ok: true, value };
}

function hasUnitLiteral(n: ExprNode): boolean {
  switch (n.t) {
    case "num":
      return n.unit !== undefined;
    case "ref":
      return false;
    case "call":
      return n.args.some(hasUnitLiteral);
    case "bin":
      return hasUnitLiteral(n.l) || hasUnitLiteral(n.r);
    case "neg":
    case "not":
      return hasUnitLiteral(n.e);
  }
}

/** Set or add a user parameter's expression. Validate with validateExpr first, this trusts its input;
 *  store.mutate()'s recompute evaluates it. */
export function commitParamExpr(doc: CadDocument, name: string, expr: string, unit?: ParamDef["unit"]): void {
  const defs = defsOf(doc);
  const def = defs[name];
  if (def) def.expr = expr;
  else defs[name] = { expr, value: 0, unit: unit ?? "mm" }; // new user parameter; value set by recompute
}

const OBJECT_PROTO_NAMES = new Set([
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Reject bad user-parameter names in one place. Returns an error or null. */
export function validateName(defs: Record<string, ParamDef>, name: string): string | null {
  if (!isIdentName(name)) return "names are letters, digits and _ (not starting with a digit)";
  if (isReservedName(name)) return `"${name}" is a reserved name`;
  if (OBJECT_PROTO_NAMES.has(name)) return `"${name}" is a reserved name`;
  if (name in defs) return `"${name}" already exists`;
  if (/^d\d+$/.test(name)) return "dN names are reserved for model parameters";
  return null;
}

export function boundParam(doc: CadDocument, target: ParamTarget): string | null {
  for (const [name, def] of Object.entries(defsOf(doc))) {
    if (def.target && sameTarget(def.target, target)) return name;
  }
  return null;
}

export function sameTarget(a: ParamTarget, b: ParamTarget): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "feature":
      return b.kind === "feature" && a.feature === b.feature && a.field === b.field;
    case "constraint":
      return b.kind === "constraint" && a.sketch === b.sketch && a.constraint === b.constraint;
    case "entity":
      return b.kind === "entity" && a.sketch === b.sketch && a.entity === b.entity && a.field === b.field;
    case "pattern":
      return b.kind === "pattern" && a.sketch === b.sketch && a.pattern === b.pattern && a.field === b.field;
  }
}

/** True when `target` is driven by a non-literal expression, drag tools must
 *  not overwrite it (the fx: rule). The single definition of the fx predicate. */
export function isBound(doc: CadDocument, target: ParamTarget): boolean {
  const name = boundParam(doc, target);
  return name !== null && !isNumericLiteral(defsOf(doc)[name]!.expr);
}

/** The parameter that `target`'s binding merely names (expr "wall_blend_r"), else null. Only a bare name is safe
 *  for a drag tool to edit, by writing the referenced value, since recompute would overwrite this field's wrapper. */
export function bareParamRef(doc: CadDocument, target: ParamTarget): string | null {
  const name = boundParam(doc, target);
  if (!name) return null;
  const expr = defsOf(doc)[name]!.expr.trim();
  return isIdentName(expr) && expr in defsOf(doc) ? expr : null;
}

/** Bind an expression to a field, updating its model param or minting the next dN. Validate with validateExpr
 *  first (bound name from boundParam, or null); recompute evaluates it. */
export function commitFieldExpr(doc: CadDocument, target: ParamTarget, expr: string, kind: FieldKind): void {
  const defs = defsOf(doc);
  const existing = boundParam(doc, target);
  if (existing) {
    defs[existing]!.expr = expr;
  } else {
    defs[nextDName(defs)] = { expr, value: 0, unit: kindUnit(kind), target };
  }
}

/** Fusion's on-the-fly `name=expr` in a dim field: the field's model param takes the chosen name. Validate the
 *  name and the expr first, this trusts its input. */
export function commitNamedFieldExpr(
  doc: CadDocument,
  target: ParamTarget,
  name: string,
  expr: string,
  kind: FieldKind,
): void {
  const defs = defsOf(doc);
  const existing = boundParam(doc, target);
  if (existing) commitRenameParam(doc, existing, name);
  else defs[name] = { expr: "0", value: 0, unit: kindUnit(kind), target };
  defs[name]!.expr = expr;
}

/** `width=30` typed into a field → { name, expr }; null for normal input. */
export function splitNameValue(raw: string): { name: string; expr: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/.exec(raw);
  return m ? { name: m[1]!, expr: m[2]!.trim() } : null;
}

export type ExprInput = { ok: true; value: number; expr: string; name?: string } | { ok: false; error: string };

/** Classify raw expression input for a bindable field, including `name=expr`: split, validate a new name, validate
 *  the expression. Shared by the store commit and sketch editor; `name` is set only on a real rename. */
export function classifyExprInput(
  doc: CadDocument,
  raw: string,
  kind: FieldKind | undefined,
  boundName: string | null,
  pendingName?: string | null,
): ExprInput {
  const nv = splitNameValue(raw);
  const renames = nv !== null && nv.name !== boundName && nv.name !== pendingName;
  if (nv && renames) {
    const bad = validateName(defsOf(doc), nv.name);
    if (bad) return { ok: false, error: bad };
  }
  const expr = nv ? nv.expr : raw;
  const v = validateExpr(doc, boundName, expr, kind);
  if (!v.ok) return v;
  return { ok: true, value: v.value, expr, ...(renames ? { name: nv.name } : {}) };
}

/** Visit every legacy string field (feature and sketch entity) equal to `name`. Scans all string fields minus a
 *  denylist, since pre-engine files could hold a bare name on any numeric field. */
function eachBareNameRef(doc: CadDocument, name: string, hit: (label: string, set: (v: string) => void) => void): void {
  for (const f of doc.features) {
    for (const [k, v] of Object.entries(f)) {
      if (v === name && !NON_NUM_STRING_FIELDS.has(k)) {
        hit(`${f.type} ${f.id} · ${k}`, (nv) => ((f as unknown as Record<string, unknown>)[k] = nv));
      }
      // A list of entries with ids of their own, a plugin feature's nodes say,
      // holds values the same way the feature does.
      if (!Array.isArray(v)) continue;
      for (const e of v) {
        if (typeof e !== "object" || e === null || typeof e.id !== "string") continue;
        const entry = e as Record<string, unknown>;
        for (const [ek, ev] of Object.entries(entry)) {
          if (ev === name && !NON_NUM_STRING_FIELDS.has(ek)) {
            hit(`${f.type} ${f.id} · ${k}.${entry["id"]}.${ek}`, (nv) => (entry[ek] = nv));
          }
        }
      }
    }
    const sketch = asFeature(f, "sketch");
    if (!sketch) continue;
    for (const e of sketch.entities) {
      for (const [k, v] of Object.entries(e)) {
        if (v === name && !NON_NUM_STRING_FIELDS.has(k)) {
          hit(`${e.type} in ${sketch.id} · ${k}`, (nv) => ((e as unknown as Record<string, unknown>)[k] = nv));
        }
      }
    }
  }
}

/** Everything that references `name`: expressions, checks, configuration values that read it, and legacy
 *  bare-name fields. A configuration that only sets `name` is not a reference; deleting drops that entry. */
export function referencesTo(doc: CadDocument, name: string): string[] {
  const defs = defsOf(doc);
  const out: string[] = [];
  for (const [n, def] of Object.entries(defs)) {
    if (n !== name && refsOf(def, defs).includes(name)) out.push(n);
  }
  const extras = doc.paramExtras;
  for (const c of extras?.checks ?? []) {
    if (exprRefs(c.expr).includes(name)) out.push(`check "${c.message}"`);
  }
  for (const cfg of extras?.configurations ?? []) {
    for (const [param, expr] of Object.entries(cfg.values)) {
      if (param !== name && exprRefs(expr).includes(name)) out.push(`configuration ${cfg.name} · ${param}`);
    }
  }
  eachBareNameRef(doc, name, (label) => out.push(label));
  return out;
}

function exprRefs(expr: string): string[] {
  try {
    return refsOfNode(parseExpr(expr));
  } catch {
    return [];
  }
}

function renameIn(expr: string, from: string, to: string): string {
  try {
    return renameRefs(expr, from, to);
  } catch {
    return expr; // an unparsable expr can't reference anything
  }
}

/** Why `name` can't be deleted right now, or null when it's free. */
export function deleteBlockers(doc: CadDocument, name: string): string | null {
  if (!(name in defsOf(doc))) return `no parameter "${name}"`;
  const refs = referencesTo(doc, name);
  if (refs.length) return `"${name}" is referenced by: ${refs.join(", ")}`;
  return null;
}

/** Remove a parameter. Check deleteBlockers FIRST, this trusts its input. */
export function commitDeleteParam(doc: CadDocument, name: string): void {
  delete defsOf(doc)[name];
  for (const cfg of doc.paramExtras?.configurations ?? []) delete cfg.values[name];
}

/** Rename a parameter, rewriting references with the tokenizer (never regex) and legacy bare-name fields.
 *  Validate first (`from` exists, validateName(to)). */
export function commitRenameParam(doc: CadDocument, from: string, to: string): void {
  const defs = defsOf(doc);
  for (const def of Object.values(defs)) def.expr = renameIn(def.expr, from, to);
  // Rebuilt rather than reassigned in place, so a renamed parameter keeps its
  // position in the table and in whatever panel lists it in table order.
  const renamed = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n === from ? to : n, d]));
  for (const n of Object.keys(defs)) delete defs[n];
  Object.assign(defs, renamed);
  const extras = doc.paramExtras;
  for (const c of extras?.checks ?? []) c.expr = renameIn(c.expr, from, to);
  for (const cfg of extras?.configurations ?? []) {
    cfg.values = Object.fromEntries(
      Object.entries(cfg.values).map(([n, e]) => [n === from ? to : n, renameIn(e, from, to)]),
    );
  }
  eachBareNameRef(doc, from, (_label, set) => set(to));
}
