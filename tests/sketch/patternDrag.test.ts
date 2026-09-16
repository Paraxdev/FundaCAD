import { describe, it, expect } from "vitest";
import { nearCentreDot, patternSweepDeg, selectionCentre, snapAngleDeg, type PatternSweepInput } from "../../src/sketch/patternDrag";

/** centre at the origin, the source out along +X, so a cursor bearing in degrees
 *  IS the sweep the drag should read. */
function at(deg: number, extra: Partial<PatternSweepInput> = {}): PatternSweepInput {
  const rad = (deg * Math.PI) / 180;
  return {
    cx: 0, cy: 0,
    sx: 10, sy: 0,
    px: 10 * Math.cos(rad), py: 10 * Math.sin(rad),
    prev: null,
    ...extra,
  };
}

describe("patternSweepDeg", () => {
  it("measures the cursor against the first source", () => {
    expect(patternSweepDeg(at(90))).toBe(90);
    // the source is not assumed to be at three o'clock: the sweep is relative to
    // wherever it actually sits
    expect(patternSweepDeg({ ...at(90), sx: 0, sy: 10 })).toBe(0);
  });

  it("keeps climbing past half a turn instead of flipping sign", () => {
    // The bug this module exists for. atan2 reports 195 degrees as -165, so a
    // drag the long way round would collapse toward zero exactly when the user
    // is reaching for a full circle.
    expect(patternSweepDeg(at(195, { prev: 170 }))).toBe(195);
    expect(patternSweepDeg(at(270, { prev: 195 }))).toBe(270);
    expect(patternSweepDeg(at(345, { prev: 270 }))).toBe(345);
  });

  it("sweeps negative when dragged the other way", () => {
    expect(patternSweepDeg(at(-90))).toBe(-90);
    expect(patternSweepDeg(at(-195, { prev: -170 }))).toBe(-195);
  });

  it("snaps to a full turn from either side", () => {
    expect(patternSweepDeg(at(355, { prev: 340 }))).toBe(360);
    expect(patternSweepDeg(at(-355, { prev: -340 }))).toBe(-360);
  });

  it("snaps to 15 degree steps", () => {
    expect(patternSweepDeg(at(92))).toBe(90);
    expect(patternSweepDeg(at(38))).toBe(45);
    expect(patternSweepDeg(at(-22))).toBe(-15);
  });

  it("drags free while Alt is held", () => {
    expect(patternSweepDeg(at(92, { free: true }))).toBeCloseTo(92, 9);
    expect(patternSweepDeg(at(357, { prev: 340, free: true }))).toBeCloseTo(357, 9);
  });

  it("clamps at a full turn however far the drag keeps going", () => {
    expect(patternSweepDeg(at(10, { prev: 355 }))).toBe(360);
    expect(patternSweepDeg(at(90, { prev: 360 }))).toBe(360);
    expect(patternSweepDeg(at(-10, { prev: -355, free: true }))).toBe(-360);
  });

  it("comes back down from a full turn", () => {
    // clamping must not be a trap: the sweep still follows the cursor back
    expect(patternSweepDeg(at(300, { prev: 360 }))).toBe(300);
  });

  it("reports nothing when there is no direction to read", () => {
    // cursor or source sitting on the centre: no angle exists, and inventing one
    // would jerk the pattern somewhere the user did not point
    expect(patternSweepDeg({ ...at(90), px: 0, py: 0 })).toBeNull();
    expect(patternSweepDeg({ ...at(90), sx: 0, sy: 0 })).toBeNull();
  });
});

describe("snapAngleDeg", () => {
  it("lands a dragged direction on the same grid the sweep uses", () => {
    expect(snapAngleDeg(43)).toBe(45);
    expect(snapAngleDeg(-7)).toBe(0);
    expect(snapAngleDeg(-98)).toBe(-105);
  });

  it("passes the raw bearing through on a free drag", () => {
    // a row at 43 degrees is a row at 43 degrees, Alt is the escape hatch for
    // the angles the grid cannot express
    expect(snapAngleDeg(43, true)).toBe(43);
  });
});

describe("nearCentreDot", () => {
  it("grabs within the radius and not beyond it", () => {
    expect(nearCentreDot({ x: 100, y: 100 }, { x: 108, y: 108 })).toBe(true);
    expect(nearCentreDot({ x: 100, y: 100 }, { x: 100, y: 112 })).toBe(true);
    expect(nearCentreDot({ x: 100, y: 100 }, { x: 110, y: 110 })).toBe(false);
    expect(nearCentreDot({ x: 100, y: 100 }, { x: 130, y: 100 }, 40)).toBe(true);
  });

  it("never grabs a dot that did not project", () => {
    expect(nearCentreDot(null, { x: 0, y: 0 })).toBe(false);
    expect(nearCentreDot({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });
});

describe("selectionCentre", () => {
  it("is the source's own point for a single source", () => {
    expect(selectionCentre([{ x: 30, y: 0 }])).toEqual({ x: 30, y: 0 });
  });

  it("averages several sources", () => {
    expect(selectionCentre([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 15 }])).toEqual({ x: 5, y: 5 });
  });

  it("skips sources that no longer resolve", () => {
    expect(selectionCentre([null, { x: 4, y: 2 }, null])).toEqual({ x: 4, y: 2 });
    expect(selectionCentre([null])).toBeNull();
    expect(selectionCentre([])).toBeNull();
  });
});
