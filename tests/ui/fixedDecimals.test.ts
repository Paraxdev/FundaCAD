// Readouts that fix their decimals still spell the language's mark.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { spellFixed } from "../../src/ui/measure";
import { describePattern } from "../../src/features/patternMath";
import { formatProfile } from "../../src/features/profileArcMath";
import { formatTurn } from "../../src/viewport/rotateDial";
import { defaultReach, gapReport, looseEnds, nothingToTiePrompt } from "../../src/sketch/looseEnds";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";
import { formatOffBy, nearestThread } from "../../plugins/FundaCAD.Screws/threadSpec";
import { expand, specRows } from "../../plugins/FundaCAD.Screws/catalogue";
import { bedFitMessage } from "../../plugins/FundaCAD.PrintToolbox/bedFit";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
const corner = (e1: string, e2: string): SketchConstraint => ({ type: "coincident", e1, p1: 1, e2, p2: 0 });

describe("spellFixed", () => {
  it("keeps the digits, trailing zeros and the sign, and swaps only the mark", () => {
    expect(spellFixed(-3.5, 3, ",")).toBe("-3,500");
    expect(spellFixed(-3.5, 3, ".")).toBe("-3.500");
    expect(spellFixed(12.34, 0, ",")).toBe("12");
    expect(spellFixed(0, 2, ",")).toBe("0,00");
    expect(spellFixed(1234.5678, 1, ",")).toBe("1234,6");
  });
});

describe("fixed decimal readouts in German", () => {
  afterEach(() => setLanguage("system"));

  it("pattern descriptions use the comma and leave whole numbers alone", async () => {
    await setLanguage("de");
    expect(describePattern("linear", 4, 12.34, "X")).toBe("4 copies, 12,34 mm apart along X");
    expect(describePattern("circular", 5, 72.5, "Z")).toBe("5 copies over 72,5° about Z");
    expect(describePattern("linear", 3, 40, "Y")).toBe("3 copies, 40 mm apart along Y");
    await setLanguage("system");
    expect(describePattern("linear", 4, 12.34, "X")).toBe("4 copies, 12.34 mm apart along X");
  });

  it("the profile weight, the dial turn and the thread offset use the comma", async () => {
    await setLanguage("de");
    expect(formatProfile(0.25)).toBe("+0,250");
    expect(formatProfile(-0.5)).toBe("-0,500");
    expect(formatTurn(-12.3)).toBe("-12,3°");
    expect(formatTurn(345)).toBe("345°");
    expect(formatOffBy(nearestThread(5.98, true)!)).toBe("M6, 0,02 mm under nominal");
  });

  it("the loose ends prompt spells the gap with a comma", async () => {
    const ents = [
      line("a", 3, 2, 53, 2),
      line("b", 53, 2, 53, 52),
      line("c", 53, 52, 3, 52),
      line("d", 3, 52, 3, 4.5),
    ];
    const held = [corner("a", "b"), corner("b", "c"), corner("c", "d")];
    const prompt = () => nothingToTiePrompt(looseEnds(ents, held, 0.7), gapReport(ents, held, defaultReach(ents)));
    expect(prompt()).toContain("2.5 mm apart");
    await setLanguage("de");
    expect(prompt()).toContain("2,5 mm apart");
  });

  it("the bed message and the screw spec rows use the comma", async () => {
    await setLanguage("de");
    expect(bedFitMessage([100.4, 300.7, 100], [220, 220, 220])).toBe(
      "Too big for the 220 x 220 x 220 mm bed (model is 100,4 x 300,7 x 100,0 mm); scale to 73,2% to fit",
    );
    const rows = specRows(expand({ familyId: "iso4762", size: "M3", length: 10 }), { size: "M3", volume: 200 });
    expect(rows.find((r) => r.label.trim() === "Pitch")).toEqual({ label: "  Pitch", value: "0,5 mm" });
    expect(rows.find((r) => r.label === "Mass (steel)")).toEqual({ label: "Mass (steel)", value: "1,57 g" });
  });
});
