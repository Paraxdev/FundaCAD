import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { coarseStep, fineStep, hitAt, snapRing, stepCoord } from "../../src/sketch/keyCursor";
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

describe("snapRing", () => {
  const from = new THREE.Vector2(13, -2);
  const pts = (list: SnapCandidate[]) => list.map((x) => [x.p.x, x.p.y]);

  it("is empty with no candidate and with one that is only where the cursor stands", () => {
    expect(snapRing(from, [], [])).toEqual([]);
    expect(snapRing(from, [c(13, -2, 100)], [])).toEqual([]);
    expect(snapRing(from, [c(13.0009, -2, 100)], [])).toEqual([]);
  });

  it("gives one candidate as it is, and a candidate just past the bucket", () => {
    const one = c(13.0011, -2, 80, "midpoint");
    expect(snapRing(from, [one], [])).toEqual([one]);
  });

  it("orders many by distance from the cursor", () => {
    const list = [c(40, 7, 100), c(15, -2, 100), c(-30, -2.5, 100), c(13, 9, 100)];
    expect(pts(snapRing(from, list, []))).toEqual([
      [15, -2],
      [13, 9],
      [40, 7],
      [-30, -2.5],
    ]);
  });

  it("breaks an equal distance by priority, then x, then y", () => {
    const a = c(18, -2, 60, "control");
    const b = c(8, -2, 100);
    const d = c(13, 3, 100);
    const e = c(13, -7, 100);
    const ring = snapRing(from, [a, b, d, e], []);
    expect(ring).toEqual([b, e, d, a]);
    expect(snapRing(from, [e, d, a, b], [])).toEqual([b, e, d, a]);
  });

  it("keeps one candidate per spot, the highest priority, whichever comes first", () => {
    const low = c(20, 4, 60, "control");
    const high = c(20, 4, 100);
    const near = c(20.0005, 4, 80, "midpoint");
    expect(snapRing(from, [low, high, near], [])).toEqual([high]);
    expect(snapRing(from, [near, low, high], [])).toEqual([high]);
  });

  it("leaves out the spots in skip, the last placed point among them", () => {
    const list = [c(20, 4, 100), c(-6, 11, 100), c(30, 30, 100)];
    expect(pts(snapRing(from, list, [new THREE.Vector2(-6, 11.0004)]))).toEqual([
      [20, 4],
      [30, 30],
    ]);
    expect(pts(snapRing(from, list, [new THREE.Vector2(-6, 11.002)]))).toEqual([
      [20, 4],
      [-6, 11],
      [30, 30],
    ]);
  });

  it("holds the 16 nearest of 20", () => {
    const list = Array.from({ length: 20 }, (_, k) => c(13 + (k + 1) * 3.5, -2 + (k % 3), 100));
    const ring = snapRing(from, list, []);
    expect(ring).toHaveLength(16);
    expect(pts(ring)).toEqual(pts([...list].sort((a, b) => a.p.distanceTo(from) - b.p.distanceTo(from)).slice(0, 16)));
    expect(snapRing(from, list, [], 5)).toHaveLength(5);
  });

  it("does not change what it was given", () => {
    const list = [c(40, 7, 100), c(15, -2, 100)];
    snapRing(from, list, []);
    expect(pts(list)).toEqual([
      [40, 7],
      [15, -2],
    ]);
  });
});
