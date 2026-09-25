import { describe, expect, it } from "vitest";
import { rebaseHole, trackedFace, upgradeFace, withCenter } from "../../src/features/holeFace";
import type { Selector, Vec3 } from "../../src/types";

const top = (center?: Vec3): Selector =>
  ({ kind: "face", by: "tracked", point: [3, 2, 5], normal: [0, 0, 1], ...(center ? { center } : {}), body: "body1" }) as Selector;

describe("a hole's tracked face", () => {
  it("is written with a unit normal and its body", () => {
    expect(trackedFace([3, 2, 5], [0, 0, 2], "body1")).toEqual(top());
    expect(trackedFace([1, 1, 1], [0, 1, 0], null)).toEqual({ kind: "face", by: "tracked", point: [1, 1, 1], normal: [0, 1, 0] });
  });

  it("takes the build's centre once, and never over one it has", () => {
    expect(withCenter(top(), [0, 0, 5])).toEqual(top([0, 0, 5]));
    expect(withCenter(top([1, 1, 1]), [0, 0, 5])).toEqual(top([1, 1, 1]));
    expect(withCenter(top(), undefined)).toEqual(top());
    const near = { kind: "face", by: "nearest", point: [3, 2, 5] } as Selector;
    expect(withCenter(near, [0, 0, 5])).toBe(near);
  });

  it("upgrades a point-only face to a tracked one on the same spot", () => {
    const near = { kind: "face", by: "nearest", point: [3, 2, 5], body: "body1" } as Selector;
    expect(upgradeFace(near, [0, 0, 1])).toEqual(top());
    expect(upgradeFace(top([0, 0, 5]), [0, 0, 1])).toEqual(top([0, 0, 5]));
  });

  // The face went up 15 and across 25 since the hole was placed: the edit opens
  // on the holes where the build drilled them, with a centre that is current.
  it("rebases an edit onto where the face is now", () => {
    const { face, points } = rebaseHole(top([0, 0, 5]), [[3, 2, 5], [-4, 0, 5]], [25, 0, 20]);
    expect(points).toEqual([[28, 2, 20], [21, 0, 20]]);
    expect(face).toEqual({ ...top([25, 0, 20]), point: [28, 2, 20] });
  });

  it("leaves a face it cannot measure the move of alone", () => {
    const pts: Vec3[] = [[3, 2, 5]];
    expect(rebaseHole(top(), pts, [25, 0, 20])).toEqual({ face: top(), points: pts });
    expect(rebaseHole(top([0, 0, 5]), pts, undefined)).toEqual({ face: top([0, 0, 5]), points: pts });
  });
});
