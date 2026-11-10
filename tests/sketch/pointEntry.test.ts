import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { readPoint, type PointRead } from "../../src/sketch/pointEntry";
import { unitById } from "../../src/ui/measure";

const mm = unitById("mm");
const inch = unitById("in");
const U = { x: mm, y: mm };
const FROM = { x: 11, y: -4 };
const ZERO = { x: 0, y: 0 };

const typed = (x: string, y?: string) => ({
  x,
  y: y ?? "2.5",
  xTyped: true,
  yTyped: y !== undefined,
  at: { x: 99, y: 2.5 },
});
const seedOnly = (x: string, y: string, at = { x: Number(x), y: Number(y) }) => ({
  x,
  y,
  xTyped: false,
  yTyped: false,
  at,
});
const yOnly = (x: string, y: string) => ({ x, y, xTyped: false, yTyped: true, at: { x: Number(x), y: -99 } });
const bad = (r: PointRead) => (r.ok ? null : { field: r.field, problem: r.problem });

describe("readPoint words a refused entry for a person", () => {
  it.each([
    [typed("abc", "4"), "x", '"abc" is not a number'],
    [typed("4", "abc"), "y", '"abc" is not a number'],
    [typed("@abc"), "x", '"abc" is not a number'],
    [yOnly("1", "@abc"), "y", '"abc" is not a number'],
  ])("%j", (t, field, problem) => {
    expect(bad(readPoint(t, U, FROM))).toEqual({ field, problem });
  });

  it("keeps the measure parser's own words for other faults", () => {
    const r = bad(readPoint(typed("1,000", "4"), U, FROM));
    expect(r?.field).toBe("x");
    expect(r?.problem).toContain("ambiguous");
  });
});

describe("readPoint absolute", () => {
  it("reads X and Y typed, off the origin and asymmetric", () => {
    expect(readPoint(typed("13.5", "-7.25"), U, FROM)).toEqual({ ok: true, x: 13.5, y: -7.25 });
  });

  it("takes the cursor's own value for a field left alone, not its rounded text", () => {
    expect(readPoint(seedOnly("60.12", "10.57", { x: 60.1234, y: 10.5678 }), U, FROM)).toEqual({
      ok: true,
      x: 60.1234,
      y: 10.5678,
    });
    expect(readPoint(seedOnly("1.06", "-0.33", { x: 26.9875, y: -8.33 }), { x: inch, y: inch }, FROM)).toEqual({
      ok: true,
      x: 26.9875,
      y: -8.33,
    });
    expect(readPoint(typed("20"), U, FROM)).toEqual({ ok: true, x: 20, y: 2.5 });
    expect(readPoint(yOnly("6.12", "10"), U, FROM)).toEqual({ ok: true, x: 6.12, y: 10 });
  });

  it("does not read a field's text when it was left alone, whatever it holds", () => {
    expect(readPoint(seedOnly("abc", "", { x: 3.5, y: -9 }), U, FROM)).toEqual({ ok: true, x: 3.5, y: -9 });
  });

  it("reads inches and a typographic minus", () => {
    expect(readPoint(typed("2", "-1.5"), { x: inch, y: inch }, FROM)).toEqual({ ok: true, x: 50.8, y: -38.1 });
    expect(readPoint(typed("−5", "−3.5"), U, FROM)).toEqual({ ok: true, x: -5, y: -3.5 });
  });

  it("refuses an empty typed field on its own side", () => {
    expect(bad(readPoint(typed("", "4"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(typed("4", ""), U, FROM))?.field).toBe("y");
    expect(bad(readPoint(typed("4", "abc"), U, FROM))?.field).toBe("y");
  });

  it("reads a lone comma as the decimal comma when Y is typed, a pair when it is not", () => {
    expect(readPoint(typed("20,5", "10"), U, FROM)).toEqual({ ok: true, x: 20.5, y: 10 });
    expect(readPoint(typed("20,10"), U, FROM)).toEqual({ ok: true, x: 20, y: 10 });
    expect(readPoint(typed("20;10"), U, FROM)).toEqual({ ok: true, x: 20, y: 10 });
    expect(readPoint(typed("1,5;2,25"), U, FROM)).toEqual({ ok: true, x: 1.5, y: 2.25 });
  });

  it("refuses a three digit tail after the comma on both sides of the Y guard", () => {
    expect(bad(readPoint(typed("20,000"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(typed("20,000", "7"), U, FROM))?.field).toBe("x");
    expect(readPoint(typed("20,00"), U, FROM)).toEqual({ ok: true, x: 20, y: 0 });
  });

  it("refuses two commas without a semicolon and names the semicolon", () => {
    const r = bad(readPoint(typed("1,5,2,5"), U, FROM));
    expect(r?.field).toBe("x");
    expect(r?.problem).toContain(";");
  });
});

describe("readPoint relative", () => {
  it("adds @dx,dy to the last placed point", () => {
    expect(readPoint(typed("@5,3"), U, FROM)).toEqual({ ok: true, x: 16, y: -1 });
    expect(readPoint(typed("@-5,-3.5"), U, FROM)).toEqual({ ok: true, x: 6, y: -7.5 });
  });

  it("adds to 0, 0 when nothing is placed", () => {
    expect(readPoint(typed("@7,-2"), U, ZERO)).toEqual({ ok: true, x: 7, y: -2 });
  });

  it("does not read Y when X holds the pair", () => {
    expect(readPoint(typed("@5,3", "garbage"), U, FROM)).toEqual({ ok: true, x: 16, y: -1 });
  });

  it("splits on a semicolon so commas stay decimals", () => {
    expect(readPoint(typed("@1,5;2,5"), U, FROM)).toEqual({ ok: true, x: 12.5, y: -1.5 });
  });

  it("refuses the unsplittable forms on the field that holds them", () => {
    const hint = bad(readPoint(typed("@1,5,2,5"), U, FROM));
    expect(hint?.field).toBe("x");
    expect(hint?.problem).toContain(";");
    expect(bad(readPoint(typed("@1,2,3"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(typed("@"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(typed("@,3"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(typed("@5,"), U, FROM))?.field).toBe("x");
    expect(bad(readPoint(yOnly("1", "@"), U, FROM))?.field).toBe("y");
    expect(bad(readPoint(yOnly("1", "@,3"), U, FROM))?.field).toBe("y");
    expect(bad(readPoint(yOnly("1", "@x"), U, FROM))?.field).toBe("y");
  });

  it("reads a unit per part", () => {
    expect(readPoint(typed("@5mm,1 in"), U, FROM)).toEqual({ ok: true, x: 16, y: 21.4 });
    expect(readPoint(typed("@1,5 in;2 mm"), U, FROM)).toEqual({ ok: true, x: 11 + 38.1, y: -2 });
    expect(readPoint(typed("@1,2"), { x: inch, y: mm }, FROM)).toEqual({ ok: true, x: 11 + 25.4, y: -2 });
  });

  it("moves along X only for a lone @ value in X with Y left alone", () => {
    expect(readPoint(typed("@5"), U, FROM)).toEqual({ ok: true, x: 16, y: -4 });
  });

  it("lets each axis be relative or absolute on its own", () => {
    expect(readPoint(typed("@5", "@-3"), U, FROM)).toEqual({ ok: true, x: 16, y: -7 });
    expect(readPoint(typed("@5", "7"), U, FROM)).toEqual({ ok: true, x: 16, y: 7 });
    expect(readPoint(typed("9", "@3"), U, FROM)).toEqual({ ok: true, x: 9, y: -1 });
    expect(readPoint(yOnly("1", "@3"), U, FROM)).toEqual({ ok: true, x: 11, y: -1 });
    expect(bad(readPoint(typed("@5", "@1;2"), U, FROM))?.field).toBe("y");
    expect(bad(readPoint(typed("@5", "q"), U, FROM))?.field).toBe("y");
    expect(bad(readPoint(typed("q", "@3"), U, FROM))?.field).toBe("x");
  });

  it("reads a pair in Y when X is untouched, and refuses it once X is typed", () => {
    expect(readPoint(yOnly("1", "@5,3"), U, FROM)).toEqual({ ok: true, x: 16, y: -1 });
    expect(bad(readPoint(typed("8", "@5,3"), U, FROM))?.field).toBe("y");
  });
});

describe("readPoint refuses a point past the limit", () => {
  const far = (axis: string) => `${axis} is too far out, a point stays within 1 km of the origin`;

  it.each([
    ["X exactly at it", typed("1000000", "0"), { x: 1e6, y: 0 }],
    ["Y exactly at it, negative", typed("0", "-1000000"), { x: 0, y: -1e6 }],
    ["a pair just inside", typed("999999.999;999999.999"), { x: 999999.999, y: 999999.999 }],
    ["a relative value that ends on it", typed("@999989,0"), { x: 1e6, y: -4 }],
  ])("takes %s", (_, t, want) => {
    expect(readPoint(t, U, FROM)).toEqual({ ok: true, ...want });
  });

  it.each([
    ["X just past it", typed("1000000.001", "0"), "x", far("X")],
    ["Y just past it, negative", typed("0", "-1000000.001"), "y", far("Y")],
    ["X far past it", typed("1e18", "0"), "x", far("X")],
    ["X where tidy would overflow", typed("1e308", "0"), "x", far("X")],
    ["a pair's Y, marked in X that holds it", typed("0;1e7"), "x", far("Y")],
    ["a relative X", typed("@1e18,0"), "x", far("X")],
    ["a relative Y", typed("@0,1e18"), "x", far("Y")],
    ["a relative Y in its own field", typed("@0", "@1e18"), "y", far("Y")],
    ["@ in Y with X left alone", yOnly("1", "@1e18"), "y", far("Y")],
    ["a sum whose parts are each inside", typed("@999990,0"), "x", far("X")],
    ["a sum past it on Y", typed("@0,-999997"), "x", far("Y")],
    ["a sum overflowing to infinity", typed("@1e308,0"), "x", far("X")],
  ])("refuses %s", (_, t, field, problem) => {
    expect(bad(readPoint(t, U, FROM))).toEqual({ field, problem });
  });

  it("a sum from a base near the limit, either way", () => {
    const from = { x: 999999, y: 0 };
    expect(readPoint(typed("@1,0"), U, from)).toEqual({ ok: true, x: 1e6, y: 0 });
    expect(bad(readPoint(typed("@1.001,0"), U, from))).toEqual({ field: "x", problem: far("X") });
  });

  it("is a length, not a number: 39370 in is inside and 39371 in is past it", () => {
    const I = { x: inch, y: inch };
    expect(readPoint(typed("39370", "0"), I, ZERO).ok).toBe(true);
    expect(bad(readPoint(typed("39371", "0"), I, ZERO))).toEqual({ field: "x", problem: far("X") });
  });

  it("marks X for a cursor left past it with nothing typed", () => {
    expect(bad(readPoint(seedOnly("2000000", "0"), U, ZERO))).toEqual({ field: "x", problem: far("X") });
  });
});

describe("readPoint in a language with a decimal comma", () => {
  afterEach(() => setLanguage("system"));
  const LAST = { x: 17.5, y: -4.25 };

  it("reads a lone comma in X as a decimal with Y left alone", async () => {
    await setLanguage("de");
    expect(readPoint(typed("20,1"), U, FROM)).toEqual({ ok: true, x: 20.1, y: 2.5 });
    expect(readPoint(typed("20,125"), U, FROM)).toEqual({ ok: true, x: 20.125, y: 2.5 });
  });

  it("splits a pair only at a semicolon", async () => {
    await setLanguage("de");
    expect(readPoint(typed("20;10"), U, FROM)).toEqual({ ok: true, x: 20, y: 10 });
    expect(readPoint(typed("20,5;-10,25"), U, FROM)).toEqual({ ok: true, x: 20.5, y: -10.25 });
    expect(readPoint(typed("@5;3"), U, LAST)).toEqual({ ok: true, x: 22.5, y: -1.25 });
    expect(readPoint(yOnly("1", "@5;3"), U, LAST)).toEqual({ ok: true, x: 22.5, y: -1.25 });
  });

  it("reads @5,3 as a 5.3 step in X", async () => {
    await setLanguage("de");
    expect(readPoint(typed("@5,3"), U, LAST)).toEqual({ ok: true, x: 22.8, y: -4.25 });
  });

  it("refuses three parts, and keeps one field's comma out of the other", async () => {
    await setLanguage("de");
    expect(bad(readPoint(typed("1;2;3"), U, FROM))?.field).toBe("x");
    expect(readPoint(typed("20,5", "-7,75"), U, FROM)).toEqual({ ok: true, x: 20.5, y: -7.75 });
  });

  it("goes back to splitting at a lone comma in English", async () => {
    await setLanguage("de");
    await setLanguage("system");
    expect(readPoint(typed("20,10"), U, FROM)).toEqual({ ok: true, x: 20, y: 10 });
    expect(readPoint(typed("@5,3"), U, LAST)).toEqual({ ok: true, x: 22.5, y: -1.25 });
  });
});
