import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { coarseStep, fineStep, hitAt, stepCoord } from "../../src/sketch/keyCursor";
import { MIN_SNAP_STEP } from "../../src/sketch/planeGrid";
import { setUnit } from "../../src/ui/units";
import type { SnapCandidate } from "../../src/sketch/snap";

const c = (x: number, y: number, priority: number, kind: SnapCandidate["kind"] = "endpoint"): SnapCandidate => ({
  p: new THREE.Vector2(x, y),
  kind,
  priority,
});

describe("hitAt", () => {
  const list = [c(12.5, -3.25, 100), c(40, 7.5, 80, "midpoint")];

  it("finds a candidate within a thousandth of a millimetre and not beyond", () => {
    expect(hitAt(new THREE.Vector2(12.5009, -3.25), list)).toBe(list[0]);
    expect(hitAt(new THREE.Vector2(12.5, -3.2511), list)).toBeNull();
    expect(hitAt(new THREE.Vector2(40, 7.5), list)).toBe(list[1]);
  });

  it("takes the higher priority of two on the same spot, in either order", () => {
    const low = c(5, 9, 60, "control");
    const high = c(5, 9, 100);
    expect(hitAt(new THREE.Vector2(5, 9), [low, high])).toBe(high);
    expect(hitAt(new THREE.Vector2(5, 9), [high, low])).toBe(high);
  });

  it("is null for no candidates", () => {
    expect(hitAt(new THREE.Vector2(1, 2), [])).toBeNull();
  });
});

describe("stepCoord", () => {
  it("moves a lattice value one whole step either way", () => {
    expect(stepCoord(20, 10, 1)).toBe(30);
    expect(stepCoord(20, 10, -1)).toBe(10);
    expect(stepCoord(-30, 5, 1)).toBe(-25);
    expect(stepCoord(-30, 5, -1)).toBe(-35);
  });

  it("goes from between lines to the next line in the direction pressed", () => {
    expect(stepCoord(13, 10, 1)).toBe(20);
    expect(stepCoord(13, 10, -1)).toBe(10);
    expect(stepCoord(-13, 10, 1)).toBe(-10);
    expect(stepCoord(-13, 10, -1)).toBe(-20);
    expect(stepCoord(13.5, 2.5, 1)).toBe(15);
    expect(stepCoord(13.5, 2.5, -1)).toBe(12.5);
  });

  it("takes a value a hair off a line for that line", () => {
    expect(stepCoord(19.9999999, 10, 1)).toBe(30);
    expect(stepCoord(20.0000001, 10, -1)).toBe(10);
    expect(stepCoord(19.99, 10, 1)).toBe(20);
  });

  it("leaves no float fuzz on a fine step", () => {
    expect(stepCoord(0.3, 0.1, 1)).toBe(0.4);
    expect(stepCoord(0.3, 0.1, -1)).toBe(0.2);
    expect(stepCoord(0.7, 0.1, 1)).toBe(0.8);
  });

  it("runs on a whole inch lattice", () => {
    const sixteenth = 25.4 / 16;
    expect(stepCoord(sixteenth * 5, sixteenth, 1)).toBeCloseTo(sixteenth * 6, 9);
    expect(stepCoord(sixteenth * 5.4, sixteenth, -1)).toBeCloseTo(sixteenth * 5, 9);
  });
});

describe("fineStep and coarseStep", () => {
  afterEach(() => setUnit("mm"));

  it("go a fifth finer and five times coarser on the metric ladder", () => {
    expect(fineStep(10)).toBe(2);
    expect(coarseStep(10)).toBe(50);
    expect(fineStep(5)).toBe(1);
    expect(coarseStep(0.5)).toBe(2);
  });

  it("stop at the finest step a cursor can aim at", () => {
    expect(fineStep(0.05)).toBe(MIN_SNAP_STEP);
    expect(fineStep(MIN_SNAP_STEP)).toBe(MIN_SNAP_STEP);
    expect(fineStep(0.1)).toBe(0.02);
  });

  it("land on the inch ladder while the display is inches", () => {
    setUnit("in");
    expect(fineStep(25.4)).toBeCloseTo(25.4 / 4, 6);
    expect(coarseStep(25.4 / 16)).toBeCloseTo(25.4 / 4, 6);
  });
});
