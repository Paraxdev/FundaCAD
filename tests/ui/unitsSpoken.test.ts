import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { setUnit, spokenArea, spokenLength, type Unit } from "../../src/ui/units";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("en");
});

describe("spoken lengths and areas in English", () => {
  const lengths: [Unit, number, string][] = [
    ["mm", 1, "1 millimetre"],
    ["mm", 2.5, "2.5 millimetres"],
    ["mm", -1, "minus 1 millimetre"],
    ["mm", -37.25, "minus 37.25 millimetres"],
    ["mm", 0, "0 millimetres"],
    ["cm", 10, "1 centimetre"],
    ["cm", 37.5, "3.75 centimetres"],
    ["in", 25.4, "1 inch"],
    ["in", -63.5, "minus 2.5 inches"],
  ];
  it.each(lengths)("%s %f", (unit, mm, said) => {
    setUnit(unit);
    expect(spokenLength(mm)).toBe(said);
  });

  it("areas say square and follow the unit", () => {
    expect(spokenArea(1)).toBe("1 square millimetre");
    expect(spokenArea(612.5)).toBe("612.5 square millimetres");
    setUnit("cm");
    expect(spokenArea(100)).toBe("1 square centimetre");
    setUnit("in");
    expect(spokenArea(645.16)).toBe("1 square inch");
    expect(spokenArea(-1290.32)).toBe("minus 2 square inches");
  });
});

describe("spoken lengths and areas in other languages", () => {
  it("German uses the comma and keeps the unit word", async () => {
    await setLanguage("de");
    expect(spokenLength(12.5)).toBe("12,5 Millimeter");
    expect(spokenLength(-3)).toBe("minus 3 Millimeter");
    setUnit("in");
    expect(spokenLength(63.5)).toBe("2,5 Zoll");
  });

  it("French applies its own plural rule, 1,5 is singular", async () => {
    await setLanguage("fr");
    expect(spokenLength(1.5)).toBe("1,5 millimètre");
    expect(spokenLength(2)).toBe("2 millimètres");
    expect(spokenLength(-7)).toBe("moins 7 millimètres");
    expect(spokenArea(2.25)).toBe("2,25 millimètres carrés");
  });

  it("Japanese has one form", async () => {
    await setLanguage("ja");
    expect(spokenArea(600)).toBe("600 平方ミリメートル");
    expect(spokenLength(-4.5)).toBe("マイナス 4.5 ミリメートル");
  });

  it("a language switch changes the next reading and leaves no trace", async () => {
    await setLanguage("de");
    expect(spokenLength(37.5)).toBe("37,5 Millimeter");
    await setLanguage("en");
    expect(spokenLength(37.5)).toBe("37.5 millimetres");
  });
});
