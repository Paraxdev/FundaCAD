// Where a pattern's copies go. The ghosts the tool draws and the solids the
// kernel builds both come from here, so anything this gets wrong is a preview
// that lies — the worst kind of wrong, because it is believed.
import { describe, expect, it } from "vitest";
import {
  axisVector,
  circularAngles,
  clampCount,
  describePattern,
  isFullCircle,
  linearOffsets,
  MAX_DRAG_COUNT,
  MIN_COUNT,
} from "../../src/features/patternMath";

describe("clampCount", () => {
  it("rounds to whole copies", () => {
    expect(clampCount(3.4)).toBe(3);
    expect(clampCount(3.6)).toBe(4);
  });

  it("allows 1, which you have to pass through on the way to 2", () => {
    expect(clampCount(1)).toBe(MIN_COUNT);
    expect(clampCount(0)).toBe(MIN_COUNT);
    expect(clampCount(-8)).toBe(MIN_COUNT);
  });

  it("caps what a held key can reach", () => {
    expect(clampCount(5000)).toBe(MAX_DRAG_COUNT);
  });

  it("survives rubbish rather than producing NaN copies", () => {
    // Infinity is not a big number, it is a broken one — treat it as the former
    // and a held key could hang the ghost builder before the cap is reached.
    expect(clampCount(NaN)).toBe(MIN_COUNT);
    expect(clampCount(Infinity)).toBe(MIN_COUNT);
  });
});

describe("axisVector", () => {
  it("names the three global axes", () => {
    expect(axisVector("X")).toEqual([1, 0, 0]);
    expect(axisVector("Y")).toEqual([0, 1, 0]);
    expect(axisVector("Z")).toEqual([0, 0, 1]);
  });
});

describe("linearOffsets", () => {
  it("starts at the original", () => {
    // Copy 0 IS the body being patterned. A run that started at `spacing` would
    // leave a gap where the part is.
    expect(linearOffsets(4, 10)[0]).toBe(0);
  });

  it("reaches (count - 1) spacings, not count", () => {
    expect(linearOffsets(3, 20)).toEqual([0, 20, 40]);
  });

  it("gives exactly `count` copies", () => {
    for (const n of [1, 2, 7, 30]) expect(linearOffsets(n, 5)).toHaveLength(n);
  });

  it("runs backwards on a negative spacing", () => {
    expect(linearOffsets(3, -8)).toEqual([0, -8, -16]);
  });

  it("collapses to a stack at zero spacing rather than throwing", () => {
    // A legal state to hold mid-drag (the spacing crosses zero on the way to
    // negative), and one the ghosts have to be able to draw.
    expect(linearOffsets(3, 0)).toEqual([0, 0, 0]);
  });

  it("never emits NaN", () => {
    expect(linearOffsets(3, NaN)).toEqual([0, 0, 0]);
  });
});

describe("isFullCircle", () => {
  it("recognises the whole way round, in either direction", () => {
    expect(isFullCircle(360)).toBe(true);
    expect(isFullCircle(-360)).toBe(true);
  });

  it("does not mistake nearly-round for round", () => {
    expect(isFullCircle(359)).toBe(false);
    expect(isFullCircle(361)).toBe(false);
    expect(isFullCircle(180)).toBe(false);
  });
});

describe("circularAngles", () => {
  it("divides a full circle by the COUNT, so the last copy is not the first", () => {
    // The rule that is not obvious, and the one the ghost has to make the same
    // way the kernel does: at 360° over 4, dividing by the gaps (3) would put
    // copy 3 at 360° — exactly on top of copy 0, doubling the seam.
    expect(circularAngles(4, 360)).toEqual([0, 90, 180, 270]);
  });

  it("divides a partial sweep by the GAPS, so the last copy lands on the end", () => {
    expect(circularAngles(3, 90)).toEqual([0, 45, 90]);
    expect(circularAngles(5, 180)).toEqual([0, 45, 90, 135, 180]);
  });

  it("starts at the original either way", () => {
    expect(circularAngles(6, 360)[0]).toBe(0);
    expect(circularAngles(6, 120)[0]).toBe(0);
  });

  it("gives exactly `count` copies", () => {
    for (const n of [1, 2, 8, 36]) {
      expect(circularAngles(n, 360)).toHaveLength(n);
      expect(circularAngles(n, 75)).toHaveLength(n);
    }
  });

  it("puts a single copy at zero, with no division by zero", () => {
    expect(circularAngles(1, 90)).toEqual([0]);
  });

  it("sweeps the other way on a negative angle", () => {
    expect(circularAngles(3, -90)).toEqual([0, -45, -90]);
  });

  it("never emits NaN", () => {
    expect(circularAngles(3, NaN)).toEqual([0, 0, 0]);
  });
});

describe("describePattern", () => {
  it("says what the gesture currently means, in units", () => {
    expect(describePattern("linear", 4, 12.5, "X")).toBe("4 copies, 12.5 mm apart along X");
    expect(describePattern("circular", 6, 360, "Z")).toBe("6 copies over 360° about Z");
  });

  it("counts one copy in the singular", () => {
    expect(describePattern("linear", 1, 10, "Y")).toContain("1 copy,");
  });

  it("does not print a decimal point on a whole number", () => {
    expect(describePattern("linear", 3, 20, "X")).toContain("20 mm");
  });

  it("reports the clamped count, not the raw one", () => {
    // The prompt has to agree with the ghosts, and the ghosts are drawn from the
    // clamped count.
    expect(describePattern("linear", 0, 10, "X")).toContain("1 copy");
  });
});
