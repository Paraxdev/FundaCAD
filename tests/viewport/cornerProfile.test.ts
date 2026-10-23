import { describe, expect, it } from "vitest";
import {
  CIRCLE_EXPONENT,
  MAX_EXPONENT,
  SQUIRCLE_EXPONENT,
  roundedSquare,
  superellipseCorner,
  type Vec2,
} from "../../src/viewport/cornerProfile";

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

// Where the corner crosses the line from its centre to the vertex, 0 at the chord and 1 at the vertex.
const bulge = (n: number) => (2 ** (-1 / n) - 0.5) / 0.5;

describe("superellipseCorner", () => {
  it("draws the CSS squircle, |x|^4 + |y|^4 = 1 in the box from the corner's centre", () => {
    // Centre (4.1, -2.6), legs 7.3 along +x and 5.2 along +y, vertex (11.4, 2.6).
    const pts = superellipseCorner([11.4, -2.6], [11.4, 2.6], [4.1, 2.6], SQUIRCLE_EXPONENT, 24);
    expect(pts.length).toBe(25);
    for (const [x, y] of pts) {
      expect(Math.abs((x - 4.1) / 7.3) ** 4 + Math.abs((y + 2.6) / 5.2) ** 4).toBeCloseTo(1, 12);
    }
  });

  it("crosses the diagonal 2^-1/4 of the leg from the centre, further out than a circle", () => {
    const [, mid] = superellipseCorner([19.3, -4], [19.3, 3.3], [12, 3.3], SQUIRCLE_EXPONENT, 2);
    expect(mid![0] - 12).toBeCloseTo(7.3 * 2 ** -0.25, 12);
    expect(mid![1] + 4).toBeCloseTo(7.3 * 2 ** -0.25, 12);
    expect(bulge(SQUIRCLE_EXPONENT)).toBeCloseTo(0.682, 3);
    expect(bulge(CIRCLE_EXPONENT)).toBeCloseTo(Math.SQRT2 - 1, 12);
  });

  it("eases into each edge: the squircle's last steps turn far less than a circle's", () => {
    const turn = (n: number) => {
      const p = superellipseCorner([3, -7], [3, -1], [-3, -1], n, 24);
      return Math.abs(Math.atan2(p[1]![0] - p[0]![0], p[1]![1] - p[0]![1]));
    };
    expect(turn(SQUIRCLE_EXPONENT)).toBeLessThan(turn(CIRCLE_EXPONENT) / 4);
  });

  it("is an exact quarter circle at exponent 2", () => {
    const pts = superellipseCorner([7.3, -1.2], [7.3, 6.1], [0, 6.1], CIRCLE_EXPONENT, 10);
    expect(pts.length).toBe(11);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y + 1.2) - 7.3)).toBeLessThan(1e-9);
  });

  it("is the straight chamfer at exponent 1 and below", () => {
    const p0: Vec2 = [11, -2];
    const p2: Vec2 = [5, 6.5];
    for (const n of [1, 0.4, -3]) {
      for (const [x, y] of superellipseCorner(p0, [11, 6.5], p2, n, 7)) {
        const cross = (p2[0] - p0[0]) * (y - p0[1]) - (p2[1] - p0[1]) * (x - p0[0]);
        expect(Math.abs(cross)).toBeLessThan(1e-9);
      }
    }
  });

  it("reads NaN as a circle and holds the exponent to its ceiling", () => {
    const at = (n: number) => superellipseCorner([3.1, -8], [9.4, -8], [9.4, -1.7], n, 6);
    expect(at(Number.NaN)).toEqual(at(CIRCLE_EXPONENT));
    expect(at(MAX_EXPONENT + 40)).toEqual(at(MAX_EXPONENT));
    expect(at(MAX_EXPONENT - 3)).not.toEqual(at(MAX_EXPONENT));
  });

  it("keeps the exact tangent points at both ends", () => {
    const pts = superellipseCorner([3.1, -8], [9.4, -8], [9.4, -1.7], SQUIRCLE_EXPONENT, 5);
    expect(pts[0]).toEqual([3.1, -8]);
    expect(pts[5]).toEqual([9.4, -1.7]);
  });

  it("takes 1, 2 and many segments, and at least 1", () => {
    const at = (n: number) => superellipseCorner([4, 0], [4, 3], [0, 3], SQUIRCLE_EXPONENT, n);
    expect(at(1)).toEqual([
      [4, 0],
      [0, 3],
    ]);
    expect(at(0)).toEqual(at(1));
    expect(at(-3)).toEqual(at(1));
    expect(at(2).length).toBe(3);
    expect(at(10).length).toBe(11);
    expect(at(2.4)).toEqual(at(2));
    expect(at(2.6)).toEqual(at(3));
  });
});

describe("roundedSquare", () => {
  it("draws the whole outline counter clockwise from the (+, -) corner", () => {
    const m = 2 + 3 * 2 ** -0.25;
    const pts = roundedSquare(10, 3, SQUIRCLE_EXPONENT, 2).map(([x, y]) => [+x.toFixed(9), +y.toFixed(9)]);
    const r = +m.toFixed(9);
    expect(pts).toEqual([
      [2, -5],
      [r, -r],
      [5, -2],
      [5, 2],
      [r, r],
      [2, 5],
      [-2, 5],
      [-r, r],
      [-5, 2],
      [-5, -2],
      [-r, -r],
      [-2, -5],
    ]);
  });

  it("is the plain square at leg 0 and below", () => {
    const square = [
      [18.5, -18.5],
      [18.5, 18.5],
      [-18.5, 18.5],
      [-18.5, -18.5],
    ];
    expect(roundedSquare(37, 0, SQUIRCLE_EXPONENT, 10)).toEqual(square);
    expect(roundedSquare(37, -2, SQUIRCLE_EXPONENT, 10)).toEqual(square);
  });

  it("is a circle at a half size leg, with no repeated point, and caps a longer leg", () => {
    const pts = roundedSquare(14.6, 7.3, CIRCLE_EXPONENT, 10);
    expect(pts.length).toBe(40);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y) - 7.3)).toBeLessThan(1e-9);
    const keys = new Set(pts.map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(40);
    expect(roundedSquare(14.6, 9, CIRCLE_EXPONENT, 10)).toEqual(pts);
  });

  it("counts segments + 1 points a corner below a half size leg", () => {
    expect(roundedSquare(37, 7.3, SQUIRCLE_EXPONENT, 1).length).toBe(8);
    expect(roundedSquare(37, 7.3, SQUIRCLE_EXPONENT, 2).length).toBe(12);
    expect(roundedSquare(37, 7.3, SQUIRCLE_EXPONENT, 24).length).toBe(100);
  });

  it("fills its whole box, between the chamfered and the plain square", () => {
    const size = 37;
    const leg = 7.3;
    const at = (n: number) => roundedSquare(size, leg, n, 24);
    for (const n of [1, CIRCLE_EXPONENT, SQUIRCLE_EXPONENT, 9]) {
      expect(bounds(at(n))).toEqual({ minX: -18.5, maxX: 18.5, minY: -18.5, maxY: 18.5 });
      expect(signedArea(at(n))).toBeGreaterThan(0);
    }
    const chamfer = size * size - 2 * leg * leg;
    expect(signedArea(at(1))).toBeCloseTo(chamfer, 9);
    expect(signedArea(at(CIRCLE_EXPONENT))).toBeGreaterThan(chamfer);
    expect(signedArea(at(SQUIRCLE_EXPONENT))).toBeGreaterThan(signedArea(at(CIRCLE_EXPONENT)));
    expect(signedArea(at(9))).toBeGreaterThan(signedArea(at(SQUIRCLE_EXPONENT)));
    expect(signedArea(at(9))).toBeLessThan(size * size);
  });
});
