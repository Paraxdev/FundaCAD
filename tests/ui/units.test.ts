import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import {
  fmtArea,
  fmtGridStep,
  fmtLength,
  fmtLengthCompact,
  setUnit,
  spokenArea,
  spokenLength,
  type Unit,
} from "../../src/ui/units";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

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
    ["in", 12.5, "0.492 inches"],
    ["in", -50.8, "minus 2 inches"],
    ["cm", 0, "0 centimetres"],
    ["cm", 12.5, "1.25 centimetres"],
    ["cm", -10, "minus 1 centimetre"],
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

describe("shown and spoken numbers take the language's decimal mark", () => {
  type Row = [string, Unit, number, string[]];
  // fmtLength, fmtArea, fmtLengthCompact, fmtGridStep, spokenLength, spokenArea
  const cases: Row[] = [
    [
      "de",
      "mm",
      12.375,
      ["12,375 mm", "12,375 mm²", "12,4mm", "12,375 mm", "12,375 millimetres", "12,375 square millimetres"],
    ],
    [
      "fr",
      "mm",
      -0.35,
      ["-0,35 mm", "-0,35 mm²", "-0,35mm", "-0,35 mm", "minus 0,35 millimetres", "minus 0,35 square millimetres"],
    ],
    ["de", "mm", 1, ["1 mm", "1 mm²", "1mm", "1 mm", "1 millimetre", "1 square millimetre"]],
    ["de", "mm", 0, ["0 mm", "0 mm²", "0mm", "0 mm", "0 millimetres", "0 square millimetres"]],
    ["de", "cm", 25, ["2,5 cm", "0,25 cm²", "2,5cm", "2,5 cm", "2,5 centimetres", "0,25 square centimetres"]],
    ["de", "in", 12.5, ["0,492 in", "0,0194 in²", "0,492in", "0,492 in", "0,492 inches", "0,0194 square inches"]],
    ["de", "in", 1.5875, ["0,0625 in", "0,00246 in²", "1/16in", "1/16 in", "0,0625 inches", "0,00246 square inches"]],
    ["de", "in", 38.1, ["1,5 in", "0,0591 in²", "1,5in", "1,5 in", "1,5 inches", "0,0591 square inches"]],
    [
      "en",
      "mm",
      12.375,
      ["12.375 mm", "12.375 mm²", "12.4mm", "12.375 mm", "12.375 millimetres", "12.375 square millimetres"],
    ],
    ["en", "in", 38.1, ["1.5 in", "0.0591 in²", "1.5in", "1.5 in", "1.5 inches", "0.0591 square inches"]],
  ];
  for (const [lang, unit, v, want] of cases)
    it(`${v} in ${unit} in ${lang}`, async () => {
      await setLanguage(lang);
      setUnit(unit);
      expect([fmtLength(v), fmtArea(v), fmtLengthCompact(v), fmtGridStep(v), spokenLength(v), spokenArea(v)]).toEqual(
        want,
      );
    });

  it("a language change alone changes the next reading", async () => {
    setUnit("mm");
    const before = fmtLength(2.5);
    await setLanguage("de");
    expect([before, fmtLength(2.5)]).toEqual(["2.5 mm", "2,5 mm"]);
  });
});

describe("a fine metric grid step reads in micrometres", () => {
  // fmtLengthCompact, fmtGridStep
  const cases: [string, Unit, number, [string, string]][] = [
    ["en", "mm", 0.0005, ["0.5µm", "0.5 µm"]],
    ["en", "mm", 0.0001, ["0.1µm", "0.1 µm"]],
    ["en", "mm", 0.005, ["5µm", "5 µm"]],
    ["en", "mm", 0.01, ["0.01mm", "0.01 mm"]],
    ["en", "cm", 0.05, ["50µm", "50 µm"]],
    ["en", "cm", 0.1, ["0.01cm", "0.01 cm"]],
    ["en", "in", 0.0254, ["0.001in", "0.001 in"]],
    ["de", "mm", 0.0005, ["0,5µm", "0,5 µm"]],
  ];
  it.each(cases)("%s %s %f", async (lang, unit, mm, want) => {
    await setLanguage(lang);
    setUnit(unit);
    expect([fmtLengthCompact(mm), fmtGridStep(mm)]).toEqual(want);
  });
});
