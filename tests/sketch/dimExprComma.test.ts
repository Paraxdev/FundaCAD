// The sketch dimension editor reads a decimal comma in an expression and hands the stored point text on.

import { afterEach, describe, expect, it, vi } from "vitest";
import { SketchMode } from "../../src/sketch/sketchMode";
import { classifyExprInput } from "../../src/params/engine";
import { setLanguage } from "../../src/i18n";
import type { CadDocument } from "../../src/types";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

afterEach(() => setLanguage("system"));

const doc: CadDocument = {
  parameters: { width: 40 },
  paramDefs: { width: { expr: "40", value: 40, unit: "mm" } },
  features: [],
};

function evalDim(raw: string) {
  const mode = Object.create(SketchMode.prototype) as {
    evalDimInput(raw: string, kind: "length", key: string | null): unknown;
  };
  Object.assign(mode, {
    pendingBindings: new Map(),
    store: {
      classifyTargetExpr: (b: string | null, p: string | null, r: string, k: "length") =>
        classifyExprInput(doc, r, k, b, p),
    },
  });
  return mode.evalDimInput(raw, "length", null);
}

describe("evalDimInput with a decimal comma", () => {
  it.each([
    ["width*1,5", { value: 60, expr: "width*1.5" }],
    ["max(1,5;2,25) + width/8", { value: 7.25, expr: "max(1.5;2.25) + width/8" }],
    ["wall = width/1,6", { value: 25, expr: "width/1.6", name: "wall" }],
    ["width*0.250", { value: 10, expr: "width*0.250" }],
  ])("in German %j is stored with a point", async (raw, expected) => {
    await setLanguage("de");
    expect(evalDim(raw)).toEqual(expected);
  });

  it.each([
    ["width * 1.500", "1.500"],
    ["wall = width/1.250", "1.250"],
  ])("in German %j is refused as ambiguous", async (raw, num) => {
    await setLanguage("de");
    expect(evalDim(raw)).toEqual({
      error: `"${num}" is ambiguous, write a comma for decimals or leave the point out`,
    });
  });

  it("in English width * 1.500 is width times 1.5", () => {
    expect(evalDim("width * 1.500")).toEqual({ value: 60, expr: "width * 1.500" });
  });

  it("in German a comma after a name is still refused", async () => {
    await setLanguage("de");
    expect(evalDim("width,5")).toEqual({ error: expect.any(String) });
  });

  it("in English the same text is refused", () => {
    expect(evalDim("width*1,5")).toEqual({ error: expect.any(String) });
  });

  it("in English a point expression is stored as typed", () => {
    expect(evalDim("max(1.5;2.25) + width/8")).toEqual({ value: 7.25, expr: "max(1.5;2.25) + width/8" });
  });
});
