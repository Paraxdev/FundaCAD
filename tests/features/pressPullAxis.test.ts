// What the press/pull tool makes of the engine's faceAxis answer: whether the
// Along axis switch is offered, which way it starts, and where the arrow stands.

import { describe, it, expect } from "vitest";
import { anchorOnAxis, initialDirection, offeredAxis } from "../../src/features/pressPullAxis";

const ceiling = { axis: { origin: [0, 0, 22.5], dir: [0, 0, -1] }, hole: true, sameAsNormal: false } as const;

describe("offeredAxis", () => {
  it("offers a hole's cone ceiling, and starts on the axis", () => {
    const axis = offeredAxis({ ...ceiling, axis: { origin: [0, 0, 22.5], dir: [0, 0, -1] } });
    expect(axis).toEqual({ origin: [0, 0, 22.5], dir: [0, 0, -1], hole: true });
    expect(initialDirection(axis)).toBe("axis");
  });

  it("offers a face off its bore's axis, but starts along the normal", () => {
    const axis = offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 2] }, hole: false });
    expect(axis?.dir).toEqual([0, 0, 1]);
    expect(initialDirection(axis)).toBe("normal");
  });

  it("does not offer a flat floor square to its axis, which moves the same either way", () => {
    expect(offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, hole: false, sameAsNormal: true })).toBeNull();
  });

  it("does not offer a face with no axis, a failed call or a broken reply", () => {
    expect(offeredAxis({ reason: "the walls around the face do not all run along one axis" })).toBeNull();
    expect(offeredAxis(null)).toBeNull();
    expect(offeredAxis({ axis: { origin: [0, 0, 0], dir: [0, 0, 0] }, hole: true })).toBeNull();
    expect(offeredAxis({ axis: { origin: [0, Number.NaN, 0], dir: [0, 0, 1] }, hole: true })).toBeNull();
    expect(initialDirection(null)).toBe("normal");
  });
});

describe("anchorOnAxis", () => {
  it("drops the picked point onto the axis line", () => {
    const axis = { origin: [1, 2, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number], hole: true };
    expect(anchorOnAxis([1.3, 2.4, 7], axis)).toEqual([1, 2, 7]);
  });

  it("keeps a point already on a slanted axis where it is", () => {
    const s = Math.SQRT1_2;
    const axis = { origin: [0, 0, 0] as [number, number, number], dir: [s, 0, s] as [number, number, number], hole: false };
    const [x, y, z] = anchorOnAxis([3, 0, 3], axis);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(3);
  });
});
