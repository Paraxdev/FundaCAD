// tests/vectors/params.json, the same vectors fundacad-core runs
// (crates/fundacad-core/tests/params_vectors.rs), so the TypeScript and Rust
// evaluators are pinned to one behaviour.

import { describe, it, expect } from "vitest";
import type { CadDocument, ParamCheck, ParamDef } from "../../src/types";
import { evalExpr } from "../../src/params/eval";
import { extractRefs, isIdentName, isNumericLiteral, isReservedName, renameRefs } from "../../src/params/parse";
import { recompute, validateExpr } from "../../src/params/engine";
import { checkResults } from "../../src/params/extras";
import RAW from "../vectors/params.json";

type Expected = number | "NaN" | "Infinity" | "-Infinity";
interface Vectors {
  eval: { expr: string; values?: Record<string, number>; expect: Expected; digits?: number }[];
  errors: { expr: string; values?: Record<string, number>; error: string }[];
  refs: { expr: string; refs: string[] }[];
  rename: { expr: string; from: string; to: string; expect: string }[];
  numericLiteral: { expr: string; expect: boolean }[];
  reserved: { yes: string[]; no: string[] };
  identNames: { yes: string[]; no: string[] };
  recompute: { name: string; defs: Record<string, ParamDef>; values: Record<string, number>; issues: Record<string, string> }[];
  validate: { defs: Record<string, ParamDef>; cases: { name: string | null; expr: string; kind?: "count"; ok?: number; error?: string }[] }[];
  checks: { defs: Record<string, ParamDef>; checks: ParamCheck[]; results: { ok: boolean; error?: string }[] }[];
}

const V = RAW as unknown as Vectors;

const num = (e: Expected): number =>
  e === "NaN" ? NaN : e === "Infinity" ? Infinity : e === "-Infinity" ? -Infinity : e;

const docOf = (defs: Record<string, ParamDef>): CadDocument => ({
  parameters: {},
  paramDefs: structuredClone(defs),
  features: [],
});

describe("parameter vectors shared with fundacad-core", () => {
  it("evaluates", () => {
    for (const c of V.eval) {
      const got = evalExpr(c.expr, c.values ?? {});
      const want = num(c.expect);
      if (Number.isNaN(want)) expect(got, c.expr).toBeNaN();
      else if (c.digits !== undefined) expect(got, c.expr).toBeCloseTo(want, c.digits);
      else expect(got, c.expr).toBe(want);
    }
  });

  it("reports structural errors", () => {
    for (const c of V.errors) {
      expect(() => evalExpr(c.expr, c.values ?? {}), JSON.stringify(c.expr)).toThrow(c.error);
    }
  });

  it("finds and renames references, literals and names", () => {
    for (const c of V.refs) expect(extractRefs(c.expr).sort(), c.expr).toEqual(c.refs);
    for (const c of V.rename) expect(renameRefs(c.expr, c.from, c.to)).toBe(c.expect);
    for (const c of V.numericLiteral) expect(isNumericLiteral(c.expr), c.expr).toBe(c.expect);
    for (const n of V.reserved.yes) expect(isReservedName(n), n).toBe(true);
    for (const n of V.reserved.no) expect(isReservedName(n), n).toBe(false);
    for (const n of V.identNames.yes) expect(isIdentName(n), n).toBe(true);
    for (const n of V.identNames.no) expect(isIdentName(n), n).toBe(false);
  });

  it("resolves a table in dependency order", () => {
    for (const c of V.recompute) {
      const doc = docOf(c.defs);
      const r = recompute(doc);
      expect(doc.parameters, c.name).toEqual(c.values);
      expect(Object.keys(r.issues).sort(), c.name).toEqual(Object.keys(c.issues).sort());
      for (const [k, w] of Object.entries(c.issues)) expect(r.issues[k], `${c.name}: ${k}`).toContain(w);
    }
  });

  it("validates expressions and runs checks", () => {
    for (const g of V.validate) {
      const doc = docOf(g.defs);
      for (const c of g.cases) {
        const got = validateExpr(doc, c.name, c.expr, c.kind);
        if (c.ok !== undefined) expect(got, c.expr).toEqual({ ok: true, value: c.ok });
        else expect(got.ok ? "" : got.error, c.expr).toContain(c.error);
      }
    }
    for (const g of V.checks) {
      const doc = docOf(g.defs);
      doc.paramExtras = { checks: g.checks };
      const got = checkResults(doc);
      got.forEach((r, i) => {
        const want = g.results[i]!;
        expect(r.ok).toBe(want.ok);
        if (want.error === undefined) expect(r.error).toBeUndefined();
        else expect(r.error).toContain(want.error);
      });
    }
  });
});
