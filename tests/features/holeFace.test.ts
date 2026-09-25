import { describe, expect, it } from "vitest";
import { rebaseHole, trackedFace, upgradeFace, withExtent } from "../../src/features/holeFace";
import type { Selector, Vec3 } from "../../src/types";

const top = (center?: Vec3): Selector =>
  ({ kind: "face", by: "tracked", point: [3, 2, 5], normal: [0, 0, 1], ...(center ? { center } : {}), body: "body1" }) as Selector;

describe("a hole's tracked face", () => {
  it("is written with a unit normal and its body", () => {
    expect(trackedFace([3, 2, 5], [0, 0, 2], "body1")).toEqual(top());
    expect(trackedFace([1, 1, 1], [0, 1, 0], null)).toEqual({ kind: "face", by: "tracked", point: [1, 1, 1], normal: [0, 1, 0] });
  });

  it("takes the build's extent once, and never over an extent or a centre it has", () => {
    const rec = { extent: [-20, 20, -10, 10] as [number, number, number, number], point: [3, 2, 5] as Vec3, points: [[3, 2, 5]] as Vec3[] };
    expect(withExtent(top(), rec)).toEqual({ ...top(), extent: [-20, 20, -10, 10] });
    expect(withExtent({ ...top(), extent: [0, 1, 0, 1] } as Selector, rec)).toEqual({ ...top(), extent: [0, 1, 0, 1] });
    expect(withExtent(top([0, 0, 5]), rec)).toEqual(top([0, 0, 5]));
    expect(withExtent(top(), undefined)).toEqual(top());
    expect(withExtent(top(), { point: [3, 2, 5], points: [] })).toEqual(top());
    const near = { kind: "face", by: "nearest", point: [3, 2, 5] } as Selector;
    expect(withExtent(near, rec)).toBe(near);
  });

  it("upgrades a point-only face to a tracked one on the same spot", () => {
    const near = { kind: "face", by: "nearest", point: [3, 2, 5], body: "body1" } as Selector;
    expect(upgradeFace(near, [0, 0, 1])).toEqual(top());
    expect(upgradeFace(top([0, 0, 5]), [0, 0, 1])).toEqual(top([0, 0, 5]));
  });

  // The plate grew from 60 to 120 since the hole was placed: the edit opens on
  // the holes where the build drilled them, with an extent that is current and
  // the older centre dropped.
  it("rebases an edit onto where the face is now", () => {
    const rec = { extent: [0, 120, 0, 40] as [number, number, number, number], point: [5, 5, 6] as Vec3, points: [[5, 5, 6], [115, 35, 6]] as Vec3[] };
    const { face, points } = rebaseHole(top([30, 20, 6]), [[5, 5, 6], [55, 35, 6]], rec);
    expect(points).toEqual([[5, 5, 6], [115, 35, 6]]);
    expect(face).toEqual({ ...top(), point: [5, 5, 6], extent: [0, 120, 0, 40] });
  });

  it("keeps the centre or extent of a face the build could not measure, and the positions written against it", () => {
    const rec = { point: [3, 2, 9] as Vec3, points: [[3, 2, 9]] as Vec3[] };
    const pts: Vec3[] = [[3, 2, 5]];
    expect(rebaseHole(top([0, 0, 5]), pts, rec)).toEqual({ face: top([0, 0, 5]), points: pts });
    const extent = { ...top(), extent: [0, 60, 0, 40] } as Selector;
    expect(rebaseHole(extent, pts, rec)).toEqual({ face: extent, points: pts });
  });

  it("rebases a normal only face the build could not measure onto where it is now", () => {
    expect(rebaseHole(top(), [[3, 2, 5]], { point: [3, 2, 9], points: [[3, 2, 9]] })).toEqual({ face: { ...top(), point: [3, 2, 9] }, points: [[3, 2, 9]] });
  });

  it("leaves a face with no build record alone", () => {
    const pts: Vec3[] = [[3, 2, 5]];
    expect(rebaseHole(top([0, 0, 5]), pts, undefined)).toEqual({ face: top([0, 0, 5]), points: pts });
    expect(rebaseHole(top(), pts, { point: [3, 2, 5], points: [] })).toEqual({ face: top(), points: pts });
    const near = { kind: "face", by: "nearest", point: [3, 2, 5] } as Selector;
    expect(rebaseHole(near, pts, { point: [0, 0, 0], points: [[0, 0, 0]] })).toEqual({ face: near, points: pts });
  });
});
