import { describe, expect, it } from "vitest";
import { commasToPoints, pointsToCommas } from "../../src/params/decimalForm";
import { ExprError } from "../../src/params/parse";
import { evalExpr } from "../../src/params/eval";
import RAW from "../vectors/params.json";

describe("commasToPoints swaps a decimal comma and keeps the length", () => {
  it.each([
    ["12,375", "12.375"],
    ["-0,35", "-0.35"],
    [",5", ".5"],
    ["1,500", "1.500"],
    ["width*1,5", "width*1.5"],
    ["max(1,5;2,25)", "max(1.5;2.25)"],
    ["hole = w/1,5", "hole = w/1.5"],
    ["2,5mm", "2.5mm"],
    ["1,5e3", "1.5e3"],
    ["1,5 + 2,25 * 3,125 - 7,5", "1.5 + 2.25 * 3.125 - 7.5"],
    ["10x2,5", "10x2.5"],
    ["1,5X2,25 mm", "1.5X2.25 mm"],
    ["(1,5+2)x3,5", "(1.5+2)x3.5"],
    ["10x,5", "10x.5"],
    ["(1,5+2)X,5", "(1.5+2)X.5"],
    ["10x.5", "10x.5"],
    ["12.5", "12.5"],
    ["42", "42"],
    ["", ""],
  ])("%j", (typed, read) => {
    expect(commasToPoints(typed)).toBe(read);
    expect(commasToPoints(typed)).toHaveLength(typed.length);
  });

  it.each(["w2,5", "a,5", "(2),5", "1, 5", "w,", "3,", "max(w,5)", "a_1,25", "x2,5", "ax2,5", "w2x,5", "10x,"])(
    "leaves %j for the tokenizer to refuse",
    (typed) => {
      expect(commasToPoints(typed)).toBe(typed);
    },
  );

  it("turns a doubtful number into one the grammar refuses", () => {
    expect(commasToPoints("1,5,5")).toBe("1.5.5");
    expect(commasToPoints("1.234,5")).toBe("1.234.5");
  });

  it.each([
    ["1.500", "1.500", 0],
    ["12.000", "12.000", 0],
    ["-1.500", "1.500", 1],
    ["01.500", "01.500", 0],
    ["breite * 1.500", "1.500", 9],
    ["2.500mm", "2.500", 0],
    ["10x1.500", "1.500", 3],
    ["max(1,5; 2.125)", "2.125", 9],
  ])("refuses %j, a point before three digits after 1 or more could be a thousands point", (typed, num, at) => {
    let thrown: unknown;
    try {
      commasToPoints(typed);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ExprError);
    expect([(thrown as ExprError).message, (thrown as ExprError).pos]).toEqual([
      `"${num}" is ambiguous, write a comma for decimals or leave the point out`,
      at,
    ]);
  });

  it.each([
    ["1.50", "1.50"],
    ["1.5000", "1.5000"],
    ["2.25", "2.25"],
    ["1.2345", "1.2345"],
    ["1.500e3", "1.500e3"],
    ["0.250", "0.250"],
    ["-0.250", "-0.250"],
    ["0.125", "0.125"],
    ["0.200", "0.200"],
    ["00.250", "00.250"],
    [".500", ".500"],
    ["breite * 0.250", "breite * 0.250"],
    ["1,500", "1.500"],
    ["breite * 1,5", "breite * 1.5"],
  ])("takes %j as %j, which no thousands point could have written", (typed, read) => {
    expect(commasToPoints(typed)).toBe(read);
  });
});

describe("pointsToCommas shows the stored point form with a decimal comma", () => {
  it.each([
    ["width*1.5", "width*1,5"],
    ["max(1.5;2.25)", "max(1,5;2,25)"],
    ["2.5mm", "2,5mm"],
    ["1e-7", "1e-7"],
    ["1.5e+21", "1,5e+21"],
    ["2.75E3 + .5", "2,75E3 + ,5"],
    ["w2*3", "w2*3"],
    ["a - 12.375 / b_1 - 0.25", "a - 12,375 / b_1 - 0,25"],
    ["2 * (3.5", "2 * (3,5"],
    ["5. + 5.e3 + 5.25", "5. + 5.e3 + 5,25"],
    ["", ""],
  ])("%j", (stored, shown) => {
    expect(pointsToCommas(stored)).toBe(shown);
    expect(pointsToCommas(stored)).toHaveLength(stored.length);
  });

  it.each(["1,5", "a.b", "x.5"])("returns %j as it is", (text) => {
    expect(pointsToCommas(text)).toBe(text);
  });

  it.each([
    ["22.125°", "22,125°"],
    ["10x2.500", "10x2,500"],
    ["10x.5 + 1.500°", "10x,5 + 1,500°"],
    ["1.5.5", "1,5,5"],
    ["3.5 $ 2", "3,5 $ 2"],
    ["a = 1.5", "a = 1,5"],
    ["x,5.5", "x,5,5"],
  ])("swaps the points of %j the tokenizer refuses, and commasToPoints reads it back", (stored, shown) => {
    expect(pointsToCommas(stored)).toBe(shown);
    expect(commasToPoints(shown)).toBe(stored);
  });

  it("shows a long refused text as it shows a short one", () => {
    const stored = `${"a = 1.25 + ".repeat(200)}2.500°`;
    expect(pointsToCommas(stored)).toBe(stored.replace(/\./g, ","));
  });

  it("round trips the whole eval and error corpus of the shared vectors", () => {
    const V = RAW as unknown as {
      eval: { expr: string; values?: Record<string, number>; expect: unknown; digits?: number }[];
      errors: { expr: string; values?: Record<string, number>; error: string }[];
    };
    let changed = 0;
    for (const c of V.eval) {
      const shown = pointsToCommas(c.expr);
      if (shown !== c.expr) changed++;
      expect(commasToPoints(shown), c.expr).toBe(c.expr);
      expect(Object.is(evalExpr(commasToPoints(shown), c.values ?? {}), evalExpr(c.expr, c.values ?? {})), c.expr).toBe(
        true,
      );
    }
    for (const c of V.errors) {
      const shown = pointsToCommas(c.expr);
      expect(commasToPoints(shown), c.expr).toBe(c.expr);
      expect(() => evalExpr(commasToPoints(shown), c.values ?? {}), c.expr).toThrow(c.error);
    }
    expect(changed).toBeGreaterThan(10);
  });
});
