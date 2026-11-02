import { describe, expect, it } from "vitest";
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
});
const seedOnly = (x: string, y: string) => ({ x, y, xTyped: false, yTyped: false });
const yOnly = (x: string, y: string) => ({ x, y, xTyped: false, yTyped: true });
const bad = (r: PointRead) => (r.ok ? null : { field: r.field, problem: r.problem });

describe("readPoint absolute", () => {
  it("reads X and Y typed, off the origin and asymmetric", () => {
    expect(readPoint(typed("13.5", "-7.25"), U, FROM)).toEqual({ ok: true, x: 13.5, y: -7.25 });
  });

  it("takes the seeded text for a field left alone", () => {
    expect(readPoint(seedOnly("3.5", "-9"), U, FROM)).toEqual({ ok: true, x: 3.5, y: -9 });
    expect(readPoint(typed("20"), U, FROM)).toEqual({ ok: true, x: 20, y: 2.5 });
    expect(readPoint(yOnly("6", "10"), U, FROM)).toEqual({ ok: true, x: 6, y: 10 });
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
