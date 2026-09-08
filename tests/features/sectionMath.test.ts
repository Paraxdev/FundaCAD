import { describe, it, expect } from "vitest";
import type { Vec3 } from "../../src/types";
import {
  GHOST_DEFAULT,
  GHOST_LEVELS,
  clipPlaneAt,
  ghostAlpha,
  ghostLabel,
  nextGhostLevel,
  sectionCentre,
  sectionFromPlaneDef,
} from "../../src/features/sectionMath";

/** Signed distance of a point from a clip plane, positive is the kept side. */
const side = (p: { normal: Vec3; constant: number }, x: Vec3) =>
  p.normal[0] * x[0] + p.normal[1] * x[1] + p.normal[2] * x[2] + p.constant;

describe("clipPlaneAt", () => {
  it("keeps the +normal half at zero offset", () => {
    const p = clipPlaneAt([0, 0, 0], [0, 0, 1], 0, 1);
    expect(side(p, [0, 0, 5])).toBeGreaterThan(0);
    expect(side(p, [0, 0, -5])).toBeLessThan(0);
  });

  it("slides the cut along the normal by the offset", () => {
    const p = clipPlaneAt([0, 0, 0], [0, 0, 1], 4, 1);
    expect(side(p, [0, 0, 4])).toBeCloseTo(0, 10);
    expect(side(p, [0, 0, 3])).toBeLessThan(0); // now cut away
  });

  it("flips which half survives without moving the cut", () => {
    // F must swap the kept side and NOTHING else: the plane stays where the
    // drag left it, so pressing F does not also teleport the section.
    const keep = clipPlaneAt([0, 0, 0], [0, 0, 1], 4, 1);
    const flip = clipPlaneAt([0, 0, 0], [0, 0, 1], 4, -1);
    expect(side(flip, [0, 0, 4])).toBeCloseTo(0, 10);
    expect(Math.sign(side(keep, [0, 0, 9]))).toBe(-Math.sign(side(flip, [0, 0, 9])));
  });

  it("moves the cut the SAME way after a flip", () => {
    // Offset runs along the defining normal, not the kept side's, otherwise
    // dragging would reverse direction the moment the user pressed F.
    const a = clipPlaneAt([0, 0, 0], [0, 0, 1], 2, -1);
    const b = clipPlaneAt([0, 0, 0], [0, 0, 1], 6, -1);
    expect(side(a, [0, 0, 2])).toBeCloseTo(0, 10);
    expect(side(b, [0, 0, 6])).toBeCloseTo(0, 10);
  });

  it("normalises a face normal that arrived unnormalised", () => {
    const p = clipPlaneAt([0, 0, 0], [0, 0, 3], 4, 1);
    expect(Math.hypot(...p.normal)).toBeCloseTo(1, 10);
    expect(side(p, [0, 0, 4])).toBeCloseTo(0, 10);
  });
});

describe("sectionCentre", () => {
  it("puts the gizmo where the cut currently is", () => {
    expect(sectionCentre([1, 2, 3], [0, 1, 0], 5)).toEqual([1, 7, 3]);
  });
});

describe("sectionFromPlaneDef", () => {
  it("cuts along a datum/face definition's own normal", () => {
    const s = sectionFromPlaneDef({ origin: [0, 0, 8], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(s).toEqual({ origin: [0, 0, 8], normal: [0, 0, 1] });
  });
});

describe("the ghost dial", () => {
  it("can still reach fully hidden, the old behaviour", () => {
    expect(GHOST_LEVELS[0]).toBe(0);
    expect(ghostAlpha(0)).toBe(0);
    expect(ghostLabel(0)).toBe("hidden");
  });

  it("starts on a level you can actually SEE", () => {
    expect(ghostAlpha(GHOST_DEFAULT)).toBeGreaterThan(0);
  });

  it("rises with the dial and cycles back to hidden", () => {
    let level = 0;
    const seen: number[] = [];
    for (let i = 0; i < GHOST_LEVELS.length; i++) {
      seen.push(ghostAlpha(level));
      level = nextGhostLevel(level);
    }
    expect(level).toBe(0); // one full turn
    expect(seen).toEqual([...GHOST_LEVELS]);
  });

  it("clamps a lost index instead of wrapping through it", () => {
    // A caller that miscounted must not silently turn the ghost OFF when it
    // meant to turn it up.
    expect(ghostAlpha(99)).toBe(GHOST_LEVELS[GHOST_LEVELS.length - 1]);
    expect(ghostAlpha(-3)).toBe(GHOST_LEVELS[0]);
  });
});
