import { describe, expect, it } from "vitest";
import { commasToPoints } from "../../src/params/decimalForm";

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
    ["12.5", "12.5"],
    ["42", "42"],
    ["", ""],
  ])("%j", (typed, read) => {
    expect(commasToPoints(typed)).toBe(read);
    expect(commasToPoints(typed)).toHaveLength(typed.length);
  });

  it.each(["w2,5", "a,5", "(2),5", "1, 5", "w,", "3,", "max(w,5)", "a_1,25"])(
    "leaves %j for the tokenizer to refuse",
    (typed) => {
      expect(commasToPoints(typed)).toBe(typed);
    },
  );

  it("turns a doubtful number into one the grammar refuses", () => {
    expect(commasToPoints("1,5,5")).toBe("1.5.5");
    expect(commasToPoints("1.234,5")).toBe("1.234.5");
  });
});
