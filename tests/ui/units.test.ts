import { afterEach, describe, expect, it } from "vitest";
import { fmtArea, setUnit, spokenArea, spokenLength, type Unit } from "../../src/ui/units";

afterEach(() => setUnit("mm"));

describe("spoken lengths follow the display unit", () => {
  const cases: [Unit, number, string][] = [
    ["mm", 37.5, "37.5 millimetres"],
    ["mm", 1, "1 millimetre"],
    ["mm", 0, "0 millimetres"],
    ["mm", -0, "0 millimetres"],
    ["mm", 2.5, "2.5 millimetres"],
    ["mm", -41.25, "minus 41.25 millimetres"],
    ["mm", -1, "minus 1 millimetre"],
    ["mm", 1.0000000001, "1 millimetre"],
    ["cm", 10, "1 centimetre"],
    ["cm", 25, "2.5 centimetres"],
    ["in", 25.4, "1 inch"],
    ["in", 50.8, "2 inches"],
    ["in", 12.7, "0.5 inches"],
  ];
  for (const [unit, mm, words] of cases)
    it(`${mm} mm in ${unit}`, () => {
      setUnit(unit);
      expect(spokenLength(mm)).toBe(words);
    });
});

describe("spoken and shown areas follow the display unit squared", () => {
  const cases: [Unit, number, string, string][] = [
    ["mm", 2400, "2400 square millimetres", "2400 mm²"],
    ["mm", 1, "1 square millimetre", "1 mm²"],
    ["mm", 0, "0 square millimetres", "0 mm²"],
    ["cm", 100, "1 square centimetre", "1 cm²"],
    ["cm", 250, "2.5 square centimetres", "2.5 cm²"],
    ["in", 645.16, "1 square inch", "1 in²"],
    ["in", 1290.32, "2 square inches", "2 in²"],
  ];
  for (const [unit, mm2, words, shown] of cases)
    it(`${mm2} mm² in ${unit}`, () => {
      setUnit(unit);
      expect([spokenArea(mm2), fmtArea(mm2)]).toEqual([words, shown]);
    });
});
