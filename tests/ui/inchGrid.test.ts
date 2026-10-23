import { afterEach, describe, expect, it } from "vitest";
import { gridStep, snapLatticeStep, GRID_CELL_PX } from "../../src/sketch/planeGrid";
import { fmtGridStep, fmtLengthCompact, niceInchStep, setUnit } from "../../src/ui/units";

const IN = 25.4;
afterEach(() => setUnit("mm"));

// Zoom whose rough cell is `inches` inches
const zoomFor = (inches: number) => (inches * IN) / GRID_CELL_PX;
const stepIn = (inches: number) => gridStep(zoomFor(inches), 0) / IN;

describe("inch grid steps", () => {
  it("steps by 1/64 to 1/2 in, then whole inches, then decades", () => {
    setUnit("in");
    const cases: [number, number][] = [
      [1 / 64, 1 / 64],
      [1 / 32, 1 / 32],
      [0.05, 1 / 16],
      [0.13, 1 / 8],
      [0.26, 1 / 4],
      [0.5, 1 / 2],
      [0.8, 1],
      [1.7, 2],
      [3.1, 2],
      [3.3, 5],
      [8, 10],
      [14, 10],
      [37, 50],
      [123, 100],
    ];
    for (const [rough, expected] of cases) expect(stepIn(rough)).toBeCloseTo(expected, 9);
  });

  it("switches at the geometric midpoint between neighbours, both sides", () => {
    setUnit("in");
    const mid = Math.sqrt((1 / 8) * (1 / 4));
    expect(stepIn(mid * 0.999)).toBeCloseTo(1 / 8, 9);
    expect(stepIn(mid * 1.001)).toBeCloseTo(1 / 4, 9);
    const wholeMid = Math.sqrt(2 * 5);
    expect(stepIn(wholeMid * 0.999)).toBeCloseTo(2, 9);
    expect(stepIn(wholeMid * 1.001)).toBeCloseTo(5, 9);
  });

  it("goes decimal under 1/64 in instead of stopping", () => {
    setUnit("in");
    const edge = 1 / 64 / Math.SQRT2;
    expect(stepIn(edge * 1.001)).toBeCloseTo(1 / 64, 9);
    expect(stepIn(edge * 0.999)).toBeCloseTo(0.01, 9);
    expect(stepIn(0.0031)).toBeCloseTo(0.002, 9);
    expect(niceInchStep(0)).toBe(IN);
    expect(niceInchStep(NaN)).toBe(IN);
  });

  it("snaps to the same lattice it draws", () => {
    setUnit("in");
    expect(snapLatticeStep(zoomFor(0.26))).toBeCloseTo(IN / 4, 9);
  });

  it("leaves mm and cm on the metric series", () => {
    for (const unit of ["mm", "cm"] as const) {
      setUnit(unit);
      expect([0.1, 0.5, 1, 1.7, 2.6, 4, 9, 30].map((r) => gridStep(r / GRID_CELL_PX, 0))).toEqual([
        0.1, 0.5, 1, 2, 2, 5, 10, 20,
      ]);
    }
  });
});

describe("inch grid labels", () => {
  it("reads sub inch steps as fractions and others as compact decimals", () => {
    setUnit("in");
    const steps = [1 / 64, 1 / 32, 3 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 10, 0.01, 0.002].map((v) => v * IN);
    expect(steps.map(fmtLengthCompact)).toEqual([
      "1/64in",
      "1/32in",
      "3/16in",
      "1/8in",
      "1/4in",
      "1/2in",
      "1in",
      "2in",
      "10in",
      "0.01in",
      "0.002in",
    ]);
    expect(fmtGridStep(IN / 16)).toBe("1/16 in");
    expect(fmtGridStep(IN * 5)).toBe("5 in");
  });

  it("keeps the worst fraction label as short as a metric one", () => {
    setUnit("in");
    expect(fmtLengthCompact(IN / 64).length).toBeLessThanOrEqual(6);
  });

  it("leaves metric labels without fractions", () => {
    setUnit("mm");
    expect(fmtLengthCompact(IN / 4)).toBe("6.35mm");
    expect(fmtGridStep(12.7)).toBe("12.7 mm");
  });
});
