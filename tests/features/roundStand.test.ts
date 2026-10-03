import { describe, it, expect } from "vitest";
import { onRoundFace, roundStand, type Cylinder } from "../../src/features/planeMath";
import type { Vec3 } from "../../src/types";

// The c1 slot end: a half cylinder of radius 2 about an axis along X through
// y 7.125, z 20, bulging towards +Y, from x -25 to 25.
const cyl: Cylinder = { axis: [1, 0, 0], point: [0, 7.125, 20], radius: 2 };
const ring = (from: number, to: number, n: number): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [-25, 25]) {
    for (let i = 0; i <= n; i++) {
      const a = from + ((to - from) * i) / n;
      out.push([x, 7.125 + 2 * Math.sin(a), 20 + 2 * Math.cos(a)]);
    }
  }
  return out;
};
const half = ring(0, Math.PI, 12);
const close = (got: readonly number[] | undefined, want: readonly number[]) =>
  want.forEach((w, i) => expect(got?.[i]).toBeCloseTo(w, 9));

describe("roundStand", () => {
  it("stands on the crown of a slot end, on the surface and halfway along", () => {
    // The triangle centroid it used to stand on was off the crown and inside
    // the chords, so the arrow leaned 17 degrees off the radius it reads.
    const s = roundStand(cyl, half, false, null, [-8.2, 9.03, 20.6])!;
    close(s.point, [0, 9.125, 20]);
    close(s.radial, [0, 1, 0]);
  });

  it("keeps a partial arc's crown but stands level with the click along it", () => {
    const s = roundStand(cyl, half, false, [12, 7.2, 21.999], [0, 9, 20])!;
    close(s.point, [12, 9.125, 20]);
    close(s.radial, [0, 1, 0]);
  });

  it("clamps the click to the face's length", () => {
    close(roundStand(cyl, half, false, [40, 9.125, 20], [0, 9, 20])!.point, [25, 9.125, 20]);
  });

  it("stands where a full round was clicked, else where the seed is", () => {
    const full = ring(0, 2 * Math.PI, 24);
    const c = Math.SQRT1_2;
    const clicked = roundStand(cyl, full, true, [5, 7.125 - 2 * c, 20 - 2 * c], [0, 9.125, 20])!;
    close(clicked.point, [5, 7.125 - 2 * c, 20 - 2 * c]);
    close(clicked.radial, [0, -c, -c]);
    const seeded = roundStand(cyl, full, true, null, [-3, 7.125, 18.1])!;
    close(seeded.point, [0, 7.125, 18]);
    close(seeded.radial, [0, 0, -1]);
  });

  it("finds the crown across the seam of the angle", () => {
    const s = roundStand(cyl, ring(Math.PI * 0.75, Math.PI * 1.25, 8), false, null, [0, 0, 0])!;
    close(s.radial, [0, 0, -1]);
  });
});

describe("onRoundFace", () => {
  it("takes a point on the cylinder within the face's length", () => {
    expect(onRoundFace(cyl, half, [3, 9.12, 20], 0.1)).toBe(true);
    expect(onRoundFace(cyl, half, [3, 8.5, 20], 0.1)).toBe(false);
    expect(onRoundFace(cyl, half, [30, 9.125, 20], 0.1)).toBe(false);
  });
});
