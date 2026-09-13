import { describe, expect, it } from "vitest";
import {
  MOVE_STEPS_PER_CELL,
  gizmoMoveStep,
  gizmoRotateStep,
  snapScaleFactor,
} from "../../src/viewport/gizmoStep";
import { gridStep } from "../../src/sketch/planeGrid";
import { FINE_DIVISOR, MIN_STEP } from "../../src/viewport/dragStep";

/** A 60mm part fitted in a 900px viewport, measured on the running app. */
const FITTED = 0.14349;

describe("gizmoMoveStep", () => {
  it("is a tenth of the grid cell drawn at the same zoom", () => {
    for (const wpp of [0.002, 0.01, FITTED, 0.5, 3.3, 12]) {
      expect(gizmoMoveStep(wpp)).toBeCloseTo(gridStep(wpp, 0) / MOVE_STEPS_PER_CELL, 9);
    }
  });

  it("gives the fitted part a 10mm grid and a 1mm step", () => {
    expect(gridStep(FITTED, 0)).toBe(10);
    expect(gizmoMoveStep(FITTED)).toBe(1);
  });

  it("follows the zoom and is monotonic", () => {
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      const step = gizmoMoveStep(1e-4 * 1.1 ** i);
      expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
    expect(gizmoMoveStep(FITTED / 10)).toBeLessThan(gizmoMoveStep(FITTED));
    expect(gizmoMoveStep(FITTED * 10)).toBeGreaterThan(gizmoMoveStep(FITTED));
  });

  it("is finer with Shift and never under the snap floor", () => {
    expect(gizmoMoveStep(FITTED, true)).toBeCloseTo(gizmoMoveStep(FITTED) / FINE_DIVISOR, 12);
    for (const wpp of [1e-9, 1e-6, 0, -1, NaN, Infinity]) {
      expect(gizmoMoveStep(wpp, true)).toBeGreaterThanOrEqual(MIN_STEP);
    }
  });
});

describe("gizmoRotateStep", () => {
  it("turns in 15 degree steps, and 1 with Shift", () => {
    expect(gizmoRotateStep()).toBe(15);
    expect(gizmoRotateStep(true)).toBe(1);
  });
});

describe("snapScaleFactor", () => {
  it("lands the extent on whole slide steps", () => {
    // 60mm resized by 1.013 is 60.78mm, which snaps to 61mm
    expect(snapScaleFactor(1.013, 60, 1) * 60).toBeCloseTo(61, 9);
    expect(snapScaleFactor(0.5, 60, 5) * 60).toBeCloseTo(30, 9);
  });

  it("never collapses the extent below one step", () => {
    expect(snapScaleFactor(0.001, 60, 1) * 60).toBeCloseTo(1, 9);
  });

  it("passes the factor through when there is no extent to measure", () => {
    expect(snapScaleFactor(1.2345, 0, 1)).toBe(1.2345);
  });
});
