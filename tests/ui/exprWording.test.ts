// An expression box words a refused number the way a value box does, and quotes what was typed.

import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { ExprError } from "../../src/params/parse";
import { storedExpr, typedExprProblem } from "../../src/ui/measure";

afterEach(() => setLanguage("system"));

describe("English expression with a lone comma before three digits", () => {
  it.each([
    ["1,000", "1,000"],
    ["width*7,250 + 3", "7,250"],
    ["  2 + 3,125  ", "3,125"],
    ["a - 12,500", "12,500"],
  ])("%j is ambiguous and quotes what was typed", (typed, quoted) => {
    const problem = typedExprProblem(typed, ".");
    expect(problem).toMatch(/ambiguous/);
    expect(problem).toContain(`"${typed.trim()}"`);
    expect(problem).toContain(quoted);
    expect(() => storedExpr(typed, ".")).toThrow(ExprError);
  });

  it.each([
    ["1,5", "one to two digits after the comma"],
    ["w*2,25", "two digits"],
    ["1,0000", "four digits"],
    ["1,000,000", "two commas"],
    ["1.5,000", "a point is present"],
    ["max(1,000)", "inside a call, the semicolon hint stays"],
    ["width*1.500", "a point is plain text in a point language"],
    ["a,000", "no digit before the comma"],
  ])("%j is refused as before, not as ambiguous (%s)", (typed) => {
    expect(storedExpr(typed, ".")).toBe(typed);
    expect(typedExprProblem(typed, ".")).toBeNull();
  });

  it("follows the language when no mark is passed", async () => {
    await setLanguage("en");
    expect(typedExprProblem("w*3,125")).toMatch(/ambiguous/);
  });
});

describe("German expression number with two marks", () => {
  it.each([
    ["1,5,5", "1,5,5"],
    ["breite * 2,25,5 + 4", "2,25,5"],
    ["x + 12,5,25,125", "12,5,25,125"],
    ["3 * 1,5,5e2", "1,5,5e2"],
  ])("%j quotes the typed text and never the stored point form", (typed, quoted) => {
    const problem = typedExprProblem(typed, ",");
    expect(problem).toContain(`"${quoted}"`);
    expect(problem).not.toContain(quoted.replace(/,/g, "."));
    expect(() => storedExpr(typed, ",")).toThrow(ExprError);
  });

  it("quotes the typed text in the language set, German and French", async () => {
    for (const lang of ["de", "fr"] as const) {
      await setLanguage(lang);
      expect(typedExprProblem("w * 2,5,5")).toContain('"2,5,5"');
    }
  });

  it.each(["1,5", "breite * 2,25 + 4", "3,5e2", "max(1,5;2,5)", "1.500"])("%j keeps its earlier outcome", (typed) => {
    const problem = typedExprProblem(typed, ",");
    if (typed === "1.500") expect(problem).toContain('"1.500" is ambiguous');
    else expect(problem).toBeNull();
  });
});
