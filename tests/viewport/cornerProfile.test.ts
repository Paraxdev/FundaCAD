import { describe, expect, it } from "vitest";
import { CIRCLE_RHO, conicCorner, conicWeight, roundedSquare, type Vec2 } from "../../src/viewport/cornerProfile";

function signedArea(pts: Vec2[]): number {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}

const bounds = (pts: Vec2[]) => ({
  minX: Math.min(...pts.map((p) => p[0])),
  maxX: Math.max(...pts.map((p) => p[0])),
  minY: Math.min(...pts.map((p) => p[1])),
  maxY: Math.max(...pts.map((p) => p[1])),
});

describe("conicCorner", () => {
  it("is an exact quarter circle at the circle's rho", () => {
    const pts = conicCorner([7.3, 0], [0, 0], [0, 7.3], CIRCLE_RHO, 10);
    expect(pts.length).toBe(11);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x - 7.3, y - 7.3) - 7.3)).toBeLessThan(1e-9);
  });

  it("puts the middle of a rho 0.25 corner 0.375 of the leg from the vertex", () => {
    const [, mid] = conicCorner([19.3, -4], [12, -4], [12, 3.3], 0.25, 2);
    expect(mid![0] - 12).toBeCloseTo(0.375 * 7.3, 12);
    expect(mid![1] + 4).toBeCloseTo(0.375 * 7.3, 12);
  });

  it("is the straight chamfer at rho 0", () => {
    const p0: Vec2 = [11, -2];
    const p2: Vec2 = [5, 6.5];
    for (const [x, y] of conicCorner(p0, [11, 6.5], p2, 0, 7)) {
      const cross = (p2[0] - p0[0]) * (y - p0[1]) - (p2[1] - p0[1]) * (x - p0[0]);
      expect(Math.abs(cross)).toBeLessThan(1e-9);
    }
  });

  it("keeps the exact tangent points at both ends", () => {
    const pts = conicCorner([3.1, -8], [9.4, -8], [9.4, -1.7], 0.6, 5);
    expect(pts[0]).toEqual([3.1, -8]);
    expect(pts[5]).toEqual([9.4, -1.7]);
  });

  it("takes 1, 2 and many segments, and at least 1", () => {
    const at = (n: number) => conicCorner([4, 0], [4, 3], [0, 3], 0.25, n);
    expect(at(1)).toEqual([[4, 0], [0, 3]]);
    expect(at(0)).toEqual(at(1));
    expect(at(-3)).toEqual(at(1));
    expect(at(2).length).toBe(3);
    expect(at(10).length).toBe(11);
    expect(at(2.4)).toEqual(at(2));
  });
});

describe("conicWeight", () => {
  it("clamps rho to 0..0.95 and reads NaN as a circle", () => {
    expect(conicWeight(CIRCLE_RHO)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(conicWeight(0.25)).toBeCloseTo(1 / 3, 12);
    expect(conicWeight(0.5)).toBe(1);
    expect(conicWeight(0)).toBe(0);
    expect(conicWeight(-0.1)).toBe(conicWeight(0));
    expect(conicWeight(0.95)).toBeCloseTo(19, 9);
    expect(conicWeight(1.2)).toBe(conicWeight(0.95));
    expect(conicWeight(Number.NaN)).toBe(conicWeight(CIRCLE_RHO));
  });
});

describe("roundedSquare", () => {
  it("draws the whole outline counter clockwise from the (+, -) corner", () => {
    expect(roundedSquare(10, 3, 0.5, 2)).toEqual([
      [2, -5], [4.25, -4.25], [5, -2],
      [5, 2], [4.25, 4.25], [2, 5],
      [-2, 5], [-4.25, 4.25], [-5, 2],
      [-5, -2], [-4.25, -4.25], [-2, -5],
    ]);
  });

  it("is the plain square at leg 0 and below", () => {
    const square = [[18.5, -18.5], [18.5, 18.5], [-18.5, 18.5], [-18.5, -18.5]];
    expect(roundedSquare(37, 0, 0.25, 10)).toEqual(square);
    expect(roundedSquare(37, -2, 0.25, 10)).toEqual(square);
  });

  it("is a circle at a half size leg, with no repeated point, and caps a longer leg", () => {
    const pts = roundedSquare(14.6, 7.3, CIRCLE_RHO, 10);
    expect(pts.length).toBe(40);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y) - 7.3)).toBeLessThan(1e-9);
    const keys = new Set(pts.map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(40);
    expect(roundedSquare(14.6, 9, CIRCLE_RHO, 10)).toEqual(pts);
  });

  it("counts segments + 1 points a corner below a half size leg", () => {
    expect(roundedSquare(37, 7.3, 0.25, 1).length).toBe(8);
    expect(roundedSquare(37, 7.3, 0.25, 2).length).toBe(12);
    expect(roundedSquare(37, 7.3, 0.25, 10).length).toBe(44);
  });

  it("fills its whole box, between the chamfered and the plain square", () => {
    const size = 37;
    const leg = 7.3;
    const at = (rho: number) => roundedSquare(size, leg, rho, 10);
    for (const rho of [0, 0.25, CIRCLE_RHO, 0.6]) {
      expect(bounds(at(rho))).toEqual({ minX: -18.5, maxX: 18.5, minY: -18.5, maxY: 18.5 });
      expect(signedArea(at(rho))).toBeGreaterThan(0);
    }
    const chamfer = size * size - 2 * leg * leg;
    expect(signedArea(at(0))).toBeCloseTo(chamfer, 9);
    expect(signedArea(at(0.25))).toBeGreaterThan(chamfer);
    expect(signedArea(at(0.25))).toBeLessThan(size * size);
    expect(signedArea(at(CIRCLE_RHO))).toBeGreaterThan(signedArea(at(0.25)));
    expect(signedArea(at(0.6))).toBeGreaterThan(signedArea(at(CIRCLE_RHO)));
  });
});
