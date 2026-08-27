// The parser every value surface reads through.
//
// Each of these was a silent wrong number before: parseFloat("2mm") is 2 in
// whatever the field was showing, parseFloat("1 inch") is 1, parseFloat("1/2")
// is 1. You always got a number back, so nothing ever reported an error — the
// part was just the wrong size.

import { describe, it, expect } from "vitest";
import {
  commonUnits,
  formatMeasure,
  roundForDisplay,
  measureError,
  normalise,
  parseMeasure,
  toUnit,
  tryParseMeasure,
  unitById,
} from "../../src/ui/measure";

const MM = unitById("mm");
const IN = unitById("in");
const DEG = unitById("deg");
const val = (raw: string, display = MM, params = {}) => parseMeasure(raw, display, params).value;

describe("a bare number takes the unit the field is showing", () => {
  it("is the display unit, not always millimetres", () => {
    expect(val("2")).toBeCloseTo(2);
    expect(val("2", IN)).toBeCloseTo(50.8);
    expect(val("2.5", unitById("cm"))).toBeCloseTo(25);
  });

  it("reports no written unit, so the field keeps the one it had", () => {
    expect(parseMeasure("2", IN).unit).toBeNull();
  });
});

describe("a written unit always wins over the field's", () => {
  it("overrides a field showing something else", () => {
    // The whole point of being unit agnostic: the field says mm, you say inch.
    expect(val("1 inch")).toBeCloseTo(25.4);
    expect(val("1inch")).toBeCloseTo(25.4);
    expect(val("1in", MM)).toBeCloseTo(25.4);
    expect(val("25.4mm", IN)).toBeCloseTo(25.4);
  });

  it("takes it attached, spaced, spelled out or as a symbol", () => {
    for (const raw of ["2in", "2 in", "2inch", "2 inches", '2"', "2″"]) {
      expect(val(raw)).toBeCloseTo(50.8);
    }
    for (const raw of ["1ft", "1 foot", "1feet", "1'", "1′"]) {
      expect(val(raw)).toBeCloseTo(304.8);
    }
  });

  it("hands back which unit was written, so the field can adopt it", () => {
    expect(parseMeasure("1 inch", MM).unit?.id).toBe("in");
    expect(parseMeasure("3cm", MM).unit?.id).toBe("cm");
  });

  it("never lets a short unit eat a long one", () => {
    // "mm" must not be read as "m", and "1m" must not become a millimetre.
    expect(val("1mm")).toBeCloseTo(1);
    expect(val("1m")).toBeCloseTo(1000);
    expect(val("1cm")).toBeCloseTo(10);
    expect(val("1um")).toBeCloseTo(0.001);
  });

  it("does not read a unit out of the front of a longer word", () => {
    // "2 index" is not two inches; "2 minutes" is not two metres.
    expect(() => parseMeasure("2 index", MM)).toThrow();
    expect(() => parseMeasure("2 minutes", MM)).toThrow();
  });

  it("does the metric ones exactly", () => {
    expect(val("1000mm")).toBe(1000);
    expect(val("1m")).toBe(1000);
    expect(val("1 thou")).toBeCloseTo(0.0254);
  });
});

describe("compounds", () => {
  it("adds a high unit to a low one written next to it", () => {
    expect(val("2'5\"")).toBeCloseTo(2 * 304.8 + 5 * 25.4);
    expect(val("1m 20cm")).toBeCloseTo(1200);
    expect(val("1ft 6in")).toBeCloseTo(457.2);
  });

  it("does NOT join across an operator", () => {
    // "2mm+3cm" is arithmetic the expression language already understood; the
    // implicit join must not fire and turn it into a third thing.
    expect(val("2mm+3cm")).toBeCloseTo(32);
    expect(val("3cm-2mm")).toBeCloseTo(28);
  });

  it("keeps the FIRST unit as the value's own", () => {
    expect(parseMeasure("2'5\"", MM).unit?.id).toBe("ft");
  });
});

describe("fractions", () => {
  it("reads a simple one", () => {
    expect(val('1/2"')).toBeCloseTo(12.7);
    expect(val("3/4 in")).toBeCloseTo(19.05);
  });

  it("reads a mixed one", () => {
    expect(val('1 1/2"')).toBeCloseTo(38.1);
    expect(val("2 3/8 in")).toBeCloseTo(60.325);
  });

  it("takes a bare fraction in the field's unit", () => {
    expect(val("1/2", IN)).toBeCloseTo(12.7);
    expect(val("1/2", MM)).toBeCloseTo(0.5);
  });

  it("is only a whole value, never a term inside a formula", () => {
    // "1 1/2" as a term would have to choose between 1+1/2 and 1*1/2, and
    // neither reading is obviously right. Inside arithmetic the slash stays
    // plain division, which is what the expression language always did.
    expect(val("6/2mm")).toBeCloseTo(3);
  });

  it("carries a leading minus", () => {
    expect(val('-1/2"')).toBeCloseTo(-12.7);
  });
});

describe("arithmetic and parameters", () => {
  it("does sums across units", () => {
    expect(val("2mm+3cm")).toBeCloseTo(32);
    expect(val("2 * 3mm")).toBeCloseTo(6);
    expect(val("(2+3)mm")).toBeCloseTo(5); // unit on the paren group's tail number
  });

  it("reads x as multiply, the way a drawing does", () => {
    expect(val("10x20")).toBeCloseTo(200);
    expect(val("10 x 20")).toBeCloseTo(200);
  });

  it("leaves a parameter called x alone", () => {
    // The x rule only fires between two numbers, so a parameter keeps its name.
    expect(val("x*2", MM, { x: 7 })).toBeCloseTo(14);
    expect(val("x", MM, { x: 7 })).toBeCloseTo(7);
  });

  it("resolves document parameters", () => {
    expect(val("width/2", MM, { width: 40 })).toBeCloseTo(20);
    expect(val("width+1in", MM, { width: 40 })).toBeCloseTo(65.4);
  });

  it("still refuses an unknown parameter rather than guessing zero", () => {
    expect(() => parseMeasure("nope*2", MM)).toThrow(/unknown parameter/);
  });
});

describe("angles are their own dimension", () => {
  it("takes degrees and radians", () => {
    expect(parseMeasure("90deg", DEG).value).toBeCloseTo(90);
    expect(parseMeasure("90°", DEG).value).toBeCloseTo(90);
    expect(parseMeasure("1rad", DEG).value).toBeCloseTo(57.2957795);
  });

  it("shows degrees with no gap before the symbol", () => {
    expect(formatMeasure(90, DEG)).toBe("90°");
    expect(formatMeasure(3.4, MM)).toBe("3.4 mm");
  });
});

describe("what counts as derived", () => {
  it("marks anything past a literal, so a field can badge it", () => {
    expect(parseMeasure("3mm", MM).derived).toBe(false);
    expect(parseMeasure("3", MM).derived).toBe(false);
    expect(parseMeasure("2mm+1mm", MM).derived).toBe(true);
    expect(parseMeasure('1/2"', MM).derived).toBe(true);
    expect(parseMeasure("2'5\"", MM).derived).toBe(true);
    expect(parseMeasure("width", MM, { width: 4 }).derived).toBe(true);
  });
});

describe("refusing rather than inventing", () => {
  it("says no to text that is not a value", () => {
    for (const bad of ["", "   ", "mm", "abc", "2 +", "((2)", '2"5', "2mm 3"]) {
      expect(tryParseMeasure(bad, MM)).toBeNull();
    }
  });

  it("has a message worth showing for each", () => {
    expect(measureError("2 +", MM)).toBeTruthy();
    expect(measureError('"', MM)).toMatch(/number in front/);
    expect(measureError("3mm", MM)).toBeNull();
  });

  it("refuses a division by zero instead of shipping Infinity into geometry", () => {
    expect(tryParseMeasure("2/0", MM)).toBeNull();
  });
});

describe("showing one back", () => {
  it("converts out of canonical", () => {
    expect(toUnit(25.4, IN)).toBeCloseTo(1);
    expect(toUnit(1000, unitById("m"))).toBeCloseTo(1);
  });

  it("round trips through the unit it was typed in", () => {
    for (const [raw, id] of [["1 inch", "in"], ["3cm", "cm"], ["2ft", "ft"]] as const) {
      const m = parseMeasure(raw, MM);
      expect(toUnit(m.value, m.unit)).toBeCloseTo(parseFloat(raw));
      expect(m.unit?.id).toBe(id);
    }
  });

  it("does not show float fuzz", () => {
    expect(formatMeasure(0.1 + 0.2, MM)).toBe("0.3 mm");
  });
});

describe("roundForDisplay", () => {
  // It used to be six places, flat, which is where "24.098723" in a diameter
  // field came from. The rule is two, and one exception.

  it("stops showing the solver's arithmetic", () => {
    expect(roundForDisplay(24.098723)).toBe(24.1);
    expect(roundForDisplay(20.039856)).toBe(20.04);
    expect(roundForDisplay(8.363363)).toBe(8.36);
  });

  it("leaves a number somebody CHOSE alone", () => {
    // Three places is the signature of a decision: it is what a field accepts
    // and what a drag lands on (viewport/dragStep.ts quantises to a nice
    // 1/2/5 step). Blunting 1.375 to 1.38 would be destroying information.
    for (const v of [1.375, 0.125, 2.5, 6.746, 40, 0.05, -3.125]) {
      expect(roundForDisplay(v), `${v}`).toBe(v);
    }
  });

  it("recognises a chosen number through a subtraction", () => {
    // The control that stops the exception above from being useless: a sketch
    // reports a length by subtracting two chosen coordinates, and floats do not
    // land on the answer exactly.
    const width = 10.123 - 3.377;
    expect(width).not.toBe(6.746); // the whole reason the tolerance is there
    expect(roundForDisplay(width)).toBe(6.746);
  });

  it("does not erase a value that lives below two places", () => {
    // Two places under 1mm is not rounding, it is deletion: 0.0523 would come
    // back as 0.05 and 0.0012 as nothing at all. Three significant digits.
    expect(roundForDisplay(0.0523841)).toBe(0.0524);
    expect(roundForDisplay(0.00123456)).toBe(0.00123);
    expect(roundForDisplay(0.39370078)).toBe(0.394);
    expect(roundForDisplay(0.0001234)).not.toBe(0);
  });

  it("still kills float fuzz, which is what six places was for", () => {
    expect(roundForDisplay(0.1 + 0.2)).toBe(0.3);
    expect(roundForDisplay(0.30000000000000004)).toBe(0.3);
  });

  it("passes a number that is not one straight through", () => {
    expect(roundForDisplay(0)).toBe(0);
    expect(Number.isNaN(roundForDisplay(NaN))).toBe(true);
    expect(roundForDisplay(Infinity)).toBe(Infinity);
  });

  it("never grows a value it rounds", () => {
    // A displayed length is read off a part. It may be blunt; it may not drift.
    for (const v of [24.098723, 0.0523841, 1.375, 0.39370078, 133.7]) {
      expect(Math.abs(roundForDisplay(v) - v), `${v}`).toBeLessThanOrEqual(Math.max(0.005, Math.abs(v) * 0.005));
    }
  });
});

describe("the unit picker's list", () => {
  it("offers lengths and angles separately, and only the everyday ones", () => {
    const lengths = commonUnits("length").map((u) => u.id);
    expect(lengths).toEqual(["mm", "cm", "m", "in", "ft"]);
    expect(lengths).not.toContain("thou"); // parses, but nobody wants it in a menu
    expect(commonUnits("angle").map((u) => u.id)).toEqual(["deg", "rad"]);
  });
});

describe("normalise, which is the part that can be wrong quietly", () => {
  it("folds every unit into the canonical one", () => {
    expect(normalise("2in").expr).toBe("50.8");
    expect(normalise("1ft").expr).toBe("304.8");
  });

  it("keeps operators, parens and names untouched", () => {
    expect(normalise("width/2").expr).toBe("width/2");
    expect(normalise("max(1;2)").expr).toBe("max(1;2)");
  });
});
