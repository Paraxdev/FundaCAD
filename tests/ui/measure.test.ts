// The parser every value surface reads through.
//
// Each of these was a silent wrong number before: parseFloat("2mm") is 2 in
// whatever the field was showing, parseFloat("1 inch") is 1, parseFloat("1/2")
// is 1. You always got a number back, so nothing ever reported an error, the
// part was just the wrong size.

import { afterEach, describe, it, expect } from "vitest";
import { setLanguage } from "../../src/i18n";
import {
  fieldNumber,
  listJoin,
  fieldError,
  commonUnits,
  spokenUnit,
  UNITS,
  formatMeasure,
  roundForDisplay,
  measureError,
  normalise,
  parseMeasure,
  toUnit,
  tryParseMeasure,
  unitById,
  canonicalTyping,
  spellNumber,
  shownExpr,
  storedExpr,
  spellRounded,
  typedExprProblem,
} from "../../src/ui/measure";
import { ExprError } from "../../src/params/parse";
import { isPlainNumber, parseField, plainNumber } from "../../src/ui/units";
import { parseHoleSize } from "../../src/features/holeStandards";

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

describe("a written unit is always preferred over the field's", () => {
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

describe("what a keyboard or a paste hands over", () => {
  it("keeps a leading minus, after select-all or not, and around a group", () => {
    expect(val("-2")).toBeCloseTo(-2);
    expect(val("- 2")).toBeCloseTo(-2);
    expect(val("-(5+2)")).toBeCloseTo(-7);
    expect(val("-.5")).toBeCloseTo(-0.5);
  });

  it("reads a typographic minus as a minus", () => {
    expect(val("\u22122")).toBeCloseTo(-2);
    expect(val("\u20132 mm")).toBeCloseTo(-2);
  });

  it("reads a decimal comma as a point, never as 205 or 20", () => {
    expect(val("20,5")).toBeCloseTo(20.5);
    expect(val("-0,25 in")).toBeCloseTo(-6.35);
    expect(canonicalTyping("20,5")).toBe("20.5");
  });

  it("refuses a comma that could be a thousands separator", () => {
    expect(tryParseMeasure("1,000", MM)).toBeNull();
    expect(measureError("1,000", MM)).toMatch(/ambiguous/);
  });

  it("leaves commas alone once there are brackets or a point", () => {
    expect(canonicalTyping("max(2,3)")).toBe("max(2,3)");
    expect(tryParseMeasure("1.000,5", MM)).toBeNull();
  });
});

describe("a decimal comma in a language that writes one", () => {
  afterEach(() => setLanguage("system"));

  it("reads 1,500 as 1.500 with a comma mark, and refuses it with a point mark", () => {
    expect(canonicalTyping("1,500", ",")).toBe("1.500");
    expect(() => canonicalTyping("1,500", ".")).toThrow(/ambiguous/);
  });

  it("reads one or four decimals the same in both marks, and keeps 0,125 a number", () => {
    expect(canonicalTyping("1,50", ",")).toBe("1.50");
    expect(canonicalTyping("1,50", ".")).toBe("1.50");
    expect(canonicalTyping("1,5000", ",")).toBe("1.5000");
    expect(canonicalTyping("1,5000", ".")).toBe("1.5000");
    expect(canonicalTyping("0,125", ",")).toBe("0.125");
    expect(canonicalTyping(",5", ",")).toBe(".5");
  });

  it("swaps every comma in brackets and in several places with a comma mark, none with a point mark", () => {
    expect(canonicalTyping("max(1,5;2,25)", ",")).toBe("max(1.5;2.25)");
    expect(canonicalTyping("1,5 + 2,25 * 3,125", ",")).toBe("1.5 + 2.25 * 3.125");
    expect(canonicalTyping("max(1,5;2,25)", ".")).toBe("max(1,5;2,25)");
    expect(canonicalTyping("1,5 + 2,25", ".")).toBe("1,5 + 2,25");
  });

  it("never guesses a doubtful number", () => {
    expect(canonicalTyping("1,5,5", ",")).toBe("1.5.5");
    expect(canonicalTyping("1.234,5", ",")).toBe("1.234.5");
  });

  it("parses typed measures whole", async () => {
    await setLanguage("de");
    expect(parseMeasure("12,375 mm", MM)).toEqual({ value: 12.375, unit: MM, derived: false });
    expect(parseMeasure("1,5 * 2,25", MM)).toEqual({ value: 3.375, unit: null, derived: true });
    expect(parseMeasure("1,500 in", MM).value).toBeCloseTo(38.1);
    expect(parseMeasure(",5", MM).value).toBe(0.5);
    expect(tryParseMeasure("1,5,5", MM)).toBeNull();
    expect(tryParseMeasure("1.234,5", MM)).toBeNull();
  });

  it("reads the compact drawing form 10x2,5 and 10x,5 as a product, as English reads 10x2.5 and 10x.5", async () => {
    await setLanguage("de");
    const de = [parseMeasure("10x2,5", MM).value, parseMeasure("1,5X3,25 mm", MM).value, fieldNumber("(1+2)x2,5")];
    const short = [parseMeasure("10x,5", MM).value, parseMeasure("10x0,5", MM).value];
    await setLanguage("system");
    const en = [parseMeasure("10x2.5", MM).value, parseMeasure("10x.5", MM).value];
    expect({ de, short, en }).toEqual({ de: [25, 4.875, 7.5], short: [5, 5], en: [25, 5] });
  });

  it("reads a field's plain number by the language, and goes back to refusing 1,500 in English", async () => {
    expect(plainNumber("1,500")).toBeNull();
    await setLanguage("de");
    expect(plainNumber("1,500")).toBe(1.5);
    expect(plainNumber("0,125")).toBe(0.125);
    expect(plainNumber("2.5")).toBe(2.5);
    await setLanguage("system");
    expect(plainNumber("1,500")).toBeNull();
  });

  it("refuses a point before exactly three digits after a nonzero whole part with a comma mark, the mirror of 1,000", () => {
    const refused: [string, string][] = [
      ["1.500", "1.500"],
      ["12.000", "12.000"],
      ["-1.500", "1.500"],
    ];
    for (const [typed, num] of refused) {
      expect(() => canonicalTyping(typed, ","), typed).toThrow(
        `"${num}" is ambiguous, write a comma for decimals or leave the point out`,
      );
    }
    const typed = ["0.250", "-0.250", "0.125", "0.200", ".500", "1.50", "1.5000", "2.25", "1.2345", "1,500", "1,5"];
    const comma = typed.map((t) => canonicalTyping(t, ","));
    const point = ["1.500", "0.250"].map((t) => canonicalTyping(t, "."));
    expect({ comma, point }).toEqual({
      comma: ["0.250", "-0.250", "0.125", "0.200", ".500", "1.50", "1.5000", "2.25", "1.2345", "1.500", "1.5"],
      point: ["1.500", "0.250"],
    });
  });

  it("keeps refusing a comma before exactly three digits in English, 0,125 included", () => {
    for (const typed of ["0,125", "-0,250", "1,500"]) {
      expect(() => canonicalTyping(typed, "."), typed).toThrow(
        `"${typed}" is ambiguous, write a point for decimals or leave the comma out`,
      );
    }
  });

  it("reads 1.500 as 1.5 in English and refuses it in German with the reason, while 0.250 and 1,500 still read", async () => {
    const en = [val("1.500"), val("0.250")];
    await setLanguage("de");
    const de = {
      refused: [measureError("1.500", MM), tryParseMeasure("-1.500", MM), plainNumber("12.000")],
      read: ["0.250", "-0.250", ".500", "1.50", "1.5000", "2.25", "1,500", "1,5", "1.2345"].map((t) => val(t)),
      plain: [plainNumber("0.250"), plainNumber("-0.250")],
      saved: plainNumber("0.125", "."),
    };
    expect({ en, de }).toEqual({
      en: [1.5, 0.25],
      de: {
        refused: ['"1.500" is ambiguous, write a comma for decimals or leave the point out', null, null],
        read: [0.25, -0.25, 0.5, 1.5, 1.5, 2.25, 1.5, 1.5, 1.2345],
        plain: [0.25, -0.25],
        saved: 0.125,
      },
    });
  });
});

describe("the other field readers", () => {
  it("a count is no longer parseFloat, so trailing junk is refused, not dropped", () => {
    expect(parseField("12abc", "count")).toBeNull();
    expect(parseField("2-", "count")).toBeNull();
    expect(parseField("20,5", "count")).toBeCloseTo(20.5);
    expect(parseField("-(5+2)", "count")).toBeCloseTo(-7);
    expect(parseField("6 mm", "count")).toBeNull();
  });

  it("a plain literal takes the same spellings", () => {
    expect(plainNumber("20,5")).toBeCloseTo(20.5);
    expect(plainNumber("\u22123")).toBe(-3);
    expect(plainNumber("1,000")).toBeNull();
    expect(plainNumber("5 mm")).toBeNull();
    expect(isPlainNumber("-2")).toBe(true);
  });

  it("a hole size accepts a decimal comma and refuses a negative", () => {
    expect(parseHoleSize("5,5")).toEqual({ diameter: 5.5 });
    expect(parseHoleSize("-5")).toBeNull();
  });
});

describe("showing one back", () => {
  it("converts out of canonical", () => {
    expect(toUnit(25.4, IN)).toBeCloseTo(1);
    expect(toUnit(1000, unitById("m"))).toBeCloseTo(1);
  });

  it("round trips through the unit it was typed in", () => {
    for (const [raw, id] of [
      ["1 inch", "in"],
      ["3cm", "cm"],
      ["2ft", "ft"],
    ] as const) {
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

describe("fieldNumber / fieldError", () => {
  it("reads arithmetic, fractions, units and a decimal comma", () => {
    expect(fieldNumber("2*5")).toBe(10);
    expect(fieldNumber("1/2")).toBe(0.5);
    expect(fieldNumber("1 in")).toBeCloseTo(25.4, 9);
    expect(fieldNumber("2,5")).toBe(2.5);
  });

  it("is NaN for blank and for text that is not a value", () => {
    expect(fieldNumber("")).toBeNaN();
    expect(fieldNumber("abc")).toBeNaN();
  });

  it("has no error for blank, a message for nonsense", () => {
    expect(fieldError("")).toBeNull();
    expect(fieldError("3*4")).toBeNull();
    expect(fieldError("3*")).toEqual(expect.any(String));
  });

  it("calls a stray comma in a plain number an unexpected character, without the semicolon hint", async () => {
    const en = [measureError("1,5,5", null), measureError("max(1, 2)", null)];
    await setLanguage("de");
    try {
      expect({ en, de: measureError("3,", null) }).toEqual({
        en: ['unexpected character ","', 'unexpected character ",", separate arguments with ";"'],
        de: 'unexpected character ","',
      });
    } finally {
      await setLanguage("system");
    }
  });
});

describe("spokenUnit", () => {
  it("lists a spoken name for every measure unit", () => {
    expect(UNITS.map((u) => [u.id, u.spoken.short, u.spoken.one, u.spoken.many])).toEqual([
      ["mm", "mm", "millimetre", "millimetres"],
      ["cm", "cm", "centimetre", "centimetres"],
      ["m", "m", "metre", "metres"],
      ["in", "in", "inch", "inches"],
      ["ft", "ft", "foot", "feet"],
      ["um", "µm", "micrometre", "micrometres"],
      ["thou", "thou", "thou", "thou"],
      ["deg", "deg", "degree", "degrees"],
      ["rad", "rad", "radian", "radians"],
    ]);
  });

  it("says the plural, the singular with one, and the short form when not in full", () => {
    for (const u of UNITS) {
      expect(spokenUnit(u.id, true)).toBe(u.spoken.many);
      expect(spokenUnit(u.id, true, true)).toBe(u.spoken.one);
      expect(spokenUnit(u.id, false)).toBe(u.spoken.short);
      expect(spokenUnit(u.id, false, true)).toBe(u.spoken.short);
    }
  });

  it("never reads the degree sign", () => {
    expect(spokenUnit("deg", false)).toBe("deg");
    expect(spokenUnit("deg", true)).toBe("degrees");
  });

  it("names the caption units both ways", () => {
    const captions: [string, string, string][] = [
      ["%", "percent", "percent"],
      ["ms", "millisecond", "milliseconds"],
      ["MPa", "megapascal", "megapascals"],
      ["N", "newton", "newtons"],
      ["g/cm³", "gram per cubic centimetre", "grams per cubic centimetre"],
    ];
    for (const [caption, one, many] of captions) {
      expect(spokenUnit(caption, true)).toBe(many);
      expect(spokenUnit(caption, true, true)).toBe(one);
      expect(spokenUnit(caption, false)).toBe(caption);
      expect(spokenUnit(caption, false, true)).toBe(caption);
    }
  });

  it("returns an unknown caption as written both ways", () => {
    for (const text of ["samples", "of the screen", ""]) {
      expect(spokenUnit(text, true)).toBe(text);
      expect(spokenUnit(text, false)).toBe(text);
      expect(spokenUnit(text, true, true)).toBe(text);
    }
  });
});

describe("spelling a number", () => {
  afterEach(() => setLanguage("system"));

  it("swaps only the point for the mark, whatever the size", () => {
    const cases: [number, string, string][] = [
      [0, "0", "0"],
      [1, "1", "1"],
      [-0.35, "-0.35", "-0,35"],
      [12.375, "12.375", "12,375"],
      [1503.25, "1503.25", "1503,25"],
      [0.000437, "0.000437", "0,000437"],
      [1.5e21, "1.5e+21", "1,5e+21"],
    ];
    for (const [n, point, comma] of cases) {
      expect(spellNumber(n, ".")).toBe(point);
      expect(spellNumber(n, ",")).toBe(comma);
    }
  });

  it("rounds like the boxes before it spells", () => {
    const cases: [number, string, string][] = [
      [12.3456, "12.35", "12,35"],
      [-0.35004, "-0.35", "-0,35"],
      [0.000437123, "0.000437", "0,000437"],
      [17.5, "17.5", "17,5"],
      [3, "3", "3"],
    ];
    for (const [v, point, comma] of cases) {
      expect(spellRounded(v, ".")).toBe(point);
      expect(spellRounded(v, ",")).toBe(comma);
    }
  });

  it("follows the active language when no mark is given", async () => {
    expect(spellNumber(12.375)).toBe("12.375");
    await setLanguage("de");
    expect(spellNumber(12.375)).toBe("12,375");
    expect(spellRounded(-4.2567)).toBe("-4,26");
    expect(formatMeasure(25.4 * 1.25, IN)).toBe("1,25 in");
    expect(formatMeasure(17.5, MM, false)).toBe("17,5mm");
    expect(formatMeasure(45.5, unitById("deg"))).toBe("45,5°");
    await setLanguage("en");
    expect(formatMeasure(25.4 * 1.25, IN)).toBe("1.25 in");
  });
});

describe("joining a list of numbers", () => {
  afterEach(() => setLanguage("system"));

  it("uses a semicolon with a comma mark and a comma with a point", () => {
    const three = ["12.5", "-3.25", "40"].map(Number);
    expect(
      listJoin(
        three.map((n) => spellNumber(n, ",")),
        ",",
      ),
    ).toBe("12,5; -3,25; 40");
    expect(
      listJoin(
        three.map((n) => spellNumber(n, ".")),
        ".",
      ),
    ).toBe("12.5, -3.25, 40");
    expect(listJoin(["7,5", "2"], ",")).toBe("7,5; 2");
  });

  it("puts no separator around one item or none", () => {
    expect(listJoin(["4,5"], ",")).toBe("4,5");
    expect(listJoin(["4.5"], ".")).toBe("4.5");
    expect(listJoin([], ",")).toBe("");
    expect(listJoin([], ".")).toBe("");
  });

  it("follows the active language when no mark is given", async () => {
    expect(listJoin(["1", "2"])).toBe("1, 2");
    await setLanguage("de");
    expect(listJoin(["1", "2"])).toBe("1; 2");
  });
});

describe("shownExpr and storedExpr, one per mark", () => {
  it.each(["22.125°", "10x2.500", "2.500 + 22.125°", "x.5 + 1.500 $"])(
    "German shows %j so that committing it unchanged stores the same text",
    async (stored) => {
      await setLanguage("de");
      let shown, back, problem;
      try {
        shown = shownExpr(stored);
        back = storedExpr(shown);
        problem = typedExprProblem(shown);
      } finally {
        await setLanguage("system");
      }
      expect({ shown, back, problem }).toEqual({
        shown: stored.replace(/(\d)\.(\d)/g, "$1,$2"),
        back: stored,
        problem: null,
      });
    },
  );

  it.each([
    ["max(width*1.5;2.25) + 0.125mm", "max(width*1,5;2,25) + 0,125mm"],
    ["a*3", "a*3"],
  ])("%j", (stored, shown) => {
    expect(shownExpr(stored, ",")).toBe(shown);
    expect(storedExpr(shown, ",")).toBe(stored);
    expect(shownExpr(stored, ".")).toBe(stored);
    expect(storedExpr(stored, ".")).toBe(stored);
  });

  it("keeps a comma in text saved before this change, in either mark", () => {
    expect(shownExpr("1,5 + x", ",")).toBe("1,5 + x");
    expect(shownExpr("1,5 + x", ".")).toBe("1,5 + x");
  });

  it("refuses breite * 1.500 in German with the reason and stores breite * 1,5 with a point, English untouched", async () => {
    await setLanguage("de");
    let de;
    try {
      de = {
        comma: [storedExpr("breite * 1,5"), typedExprProblem("breite * 1,5")],
        point: typedExprProblem("breite * 1.500"),
        shownBack: storedExpr(shownExpr("breite * 1.500")),
      };
      expect(() => storedExpr("breite * 1.500")).toThrow(ExprError);
    } finally {
      await setLanguage("system");
    }
    const en = [storedExpr("breite * 1.500"), typedExprProblem("breite * 1.500")];
    expect({ de, en }).toEqual({
      de: {
        comma: ["breite * 1.5", null],
        point: '"1.500" is ambiguous, write a comma for decimals or leave the point out',
        shownBack: "breite * 1.500",
      },
      en: ["breite * 1.500", null],
    });
  });
});
