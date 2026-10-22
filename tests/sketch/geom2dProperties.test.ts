// geom2d on slanted inputs away from the origin, the exact tolerance edges, and seeded random property checks.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { circleCircleIntersect, circleLineIntersect, distToSeg, lineIntersect, paramOnSeg, segCircleIntersect, segIntersect, signedAngleDeg } from "../../src/sketch/geom2d";
import { near } from "./solveFixtures";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const xy = (ps: THREE.Vector2[] | THREE.Vector2 | null) => (ps === null ? null : Array.isArray(ps) ? ps.map((p) => [p.x, p.y]) : [ps.x, ps.y]);
const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });
const ray = (x: number, y: number, deg: number) => seg(x, y, x + 3 * Math.cos((deg * Math.PI) / 180), y + 3 * Math.sin((deg * Math.PI) / 180));

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("lineIntersect", () => {
  it("meets two slanted lines beyond both segments", () => {
    // (100,50)+t(4,3) and (110,50)+s(-2,2) meet at t = 10/7
    expect(xy(lineIntersect(v(100, 50), v(104, 53), v(110, 50), v(108, 52)))).toEqual(near([100 + 40 / 7, 50 + 30 / 7], 9));
  });
  it("gives null for parallel slanted lines and keeps a cross product of exactly 1e-9", () => {
    expect(lineIntersect(v(100, 50), v(104, 53), v(90, 40), v(98, 46))).toBeNull();
    expect(xy(lineIntersect(v(0, 0), v(1e-9, 0), v(0, -0.5), v(0, 0.5)))).toEqual([0, 0]);
  });
});

describe("segIntersect", () => {
  // seg A runs (100,50) to (110,56); the second segment always lies on a line through A's line at X
  const A = [v(100, 50), v(110, 56)] as const;
  const crossAt = (t: number, u0: number, u1: number) => {
    const X = v(100 + 10 * t, 50 + 6 * t), d = v(-3, 5);
    return segIntersect(A[0], A[1], X.clone().addScaledVector(d, -u0), X.clone().addScaledVector(d, u1));
  };
  it("returns the crossing inside both segments", () => {
    expect(xy(crossAt(0.5, 1, 1))).toEqual(near([105, 53], 9));
    expect(xy(segIntersect(v(102, 58), v(108, 48), A[0], A[1]))).toEqual(near([105, 53], 9));
  });
  it.each([["before A", -0.2, 1, 1], ["past A", 1.2, 1, 1], ["before the other", 0.5, -0.5, 1.5], ["past the other", 0.5, 1.5, -0.5]] as const)(
    "returns null for a crossing %s", (_n, t, u0, u1) => expect(crossAt(t, u0, u1)).toBeNull());
  it("returns null for parallel and for collinear overlapping segments", () => {
    expect(segIntersect(A[0], A[1], v(100, 53), v(110, 59))).toBeNull();
    expect(segIntersect(A[0], A[1], v(102, 51.2), v(105, 53))).toBeNull();
  });
  it("accepts a crossing up to 1e-6 past either end of either segment, and no further", () => {
    const along = (t: number) => xy(segIntersect(v(0, 0), v(1, 0), v(t, -1), v(t, 1)));
    const across = (u: number) => xy(segIntersect(v(0, 0), v(1, 0), v(0.5, -u), v(0.5, 1 - u)));
    expect([along(-1e-6), along(-5e-7), along(1 + 5e-7), along(1 + 1e-6), along(1 - 5e-7)]).toEqual([[-1e-6, 0], [-5e-7, 0], [1 + 5e-7, 0], [1 + 1e-6, 0], [1 - 5e-7, 0]]);
    expect([along(-2e-6), along(1 + 2e-6)]).toEqual([null, null]);
    expect([across(-5e-7), across(1 + 5e-7), across(1 + 1e-6)]).toEqual([[0.5, 0], [0.5, 0], [0.5, 0]]);
    expect([across(-2e-6), across(1 + 2e-6)]).toEqual([null, null]);
    expect(xy(segIntersect(v(0, 0), v(1e-9, 0), v(0, -0.5), v(0, 0.5)))).toEqual([0, 0]);
  });
});

describe("circleLineIntersect", () => {
  it("returns both points of a slanted line through a circle, ordered along the line", () => {
    // foot of (103,49) on the line (100,50)+t(4,3) is (101.44,51.08), 2.6 away, so the half chord is sqrt(25 - 2.6^2)
    const hc = Math.sqrt(25 - 2.6 * 2.6);
    expect(xy(circleLineIntersect(v(100, 50), v(104, 53), v(103, 49), 5))).toEqual(near([[101.44 - 0.8 * hc, 51.08 - 0.6 * hc], [101.44 + 0.8 * hc, 51.08 + 0.6 * hc]], 9));
  });
  it("returns one point for a tangent, none for a miss or a zero length line", () => {
    expect(xy(circleLineIntersect(v(100, 53), v(110, 53), v(104, 50), 3))).toEqual([[104, 53]]);
    expect(circleLineIntersect(v(100, 50), v(104, 53), v(103, 49), 2.5)).toEqual([]);
    expect(circleLineIntersect(v(103, 49), v(103, 49), v(103, 49), 5)).toEqual([]);
  });
});

describe("segCircleIntersect", () => {
  const c = v(103, 49);
  // the segment (96,46) to (108,55) runs along (0.8,0.6); the foot of c on it is (101.92,50.44), 1.8 from c
  const foot = [101.92, 50.44], hc = Math.sqrt(25 - 1.8 * 1.8);
  it("returns both crossings of a chord inside the segment", () => {
    expect(xy(segCircleIntersect(v(96, 46), v(108, 55), c, 5))).toEqual(near([[foot[0]! - 0.8 * hc, foot[1]! - 0.6 * hc], [foot[0]! + 0.8 * hc, foot[1]! + 0.6 * hc]], 9));
  });
  it("keeps only the crossing a segment from inside the circle reaches", () => {
    expect(xy(segCircleIntersect(v(101.92, 50.44), v(108.32, 55.24), c, 5))).toEqual(near([[foot[0]! + 0.8 * hc, foot[1]! + 0.6 * hc]], 9));
  });
  it("returns none for a segment inside the circle or short of it", () => {
    expect(segCircleIntersect(v(102, 49), v(104, 50.5), c, 5)).toEqual([]);
    expect(segCircleIntersect(v(84, 32), v(92, 38), c, 5)).toEqual([]);
  });
  it("returns the tangent point twice", () => {
    expect(xy(segCircleIntersect(v(100, 53), v(110, 53), v(104, 50), 3))).toEqual([[104, 53], [104, 53]]);
  });
  it("accepts a crossing up to 1e-6 past either end", () => {
    // the circle about (100,50) with radius 5 crosses y = 50 at x = 95 and 105, a 10 long segment from x0 meets one of them
    const at = (x0: number) => (xy(segCircleIntersect(v(x0, 50), v(x0 + 10, 50), v(100, 50), 5)) as number[][]).map((p) => near(p, 9));
    expect([at(105 + 5e-6), at(85 - 5e-6), at(85 + 5e-6)]).toEqual([[near([105, 50], 9)], [near([95, 50], 9)], [near([95, 50], 9)]]);
    expect([at(105 + 2e-5), at(85 - 2e-5)]).toEqual([[], []]);
  });
});

describe("circleCircleIntersect", () => {
  // centres 6 apart along (0.8,0.6), radii 4 and 3
  const a = 43 / 12, h = Math.sqrt(16 - a * a);
  const P = (t: number, s: number) => [100 + 0.8 * t - 0.6 * s, 50 + 0.6 * t + 0.8 * s];
  it("returns the two points left then right of the centre line", () => {
    expect(xy(circleCircleIntersect(v(100, 50), 4, v(104.8, 53.6), 3))).toEqual(near([P(a, h), P(a, -h)], 9));
    expect(xy(circleCircleIntersect(v(104.8, 53.6), 3, v(100, 50), 4))).toEqual(near([P(a, -h), P(a, h)], 9));
  });
  it("returns both points of a crossing barely past touching", () => {
    // centres 5 apart, radii 2 and 3.05
    const a2 = (4 - 3.05 * 3.05 + 25) / 10, h2 = Math.sqrt(4 - a2 * a2);
    const Q = (t: number, s: number) => [100 + 0.6 * t - 0.8 * s, 50 + 0.8 * t + 0.6 * s];
    expect(xy(circleCircleIntersect(v(100, 50), 2, v(103, 54), 3.05))).toEqual(near([Q(a2, h2), Q(a2, -h2)], 9));
  });
  it("returns the single point of an outer and of an inner tangency", () => {
    expect(xy(circleCircleIntersect(v(100, 50), 2, v(103, 54), 3))).toEqual(near([[101.2, 51.6]], 9));
    expect(xy(circleCircleIntersect(v(100, 50), 8, v(103, 54), 3))).toEqual(near([[104.8, 56.4]], 9));
    expect(circleCircleIntersect(v(0, 0), 0.01, v(0.019999999999999997, 0), 0.01)).toHaveLength(1);
  });
  it("returns none for concentric, apart or nested circles", () => {
    expect(circleCircleIntersect(v(100, 50), 4, v(100, 50), 3)).toEqual([]);
    expect(circleCircleIntersect(v(100, 50), 4, v(100, 50), 4)).toEqual([]);
    expect(circleCircleIntersect(v(100, 50), 2, v(110, 60), 3)).toEqual([]);
    expect(circleCircleIntersect(v(100, 50), 8, v(101.2, 51.6), 3)).toEqual([]);
  });
  it("keeps the exact edges of its guards", () => {
    expect(xy(circleCircleIntersect(v(0, 0), 5, v(1e-9, 0), 5))).toEqual(near([[5e-10, 5], [5e-10, -5]], 9));
    expect(xy(circleCircleIntersect(v(0, 0), 5, v(5 + 3 + 1e-9, 0), 3))).toEqual(near([[5, 0]], 6));
    expect(xy(circleCircleIntersect(v(0, 0), 8, v(Math.abs(8 - 3) - 1e-9, 0), 3))).toEqual(near([[8, 0]], 6));
  });
});

describe("paramOnSeg and distToSeg", () => {
  // (100,50) to (108,56), 10 long
  const p1 = { x: 100, y: 50 }, p2 = { x: 108, y: 56 };
  it.each([["before the start", 96, 47, -0.5, 5], ["beside the middle", 102.2, 55.4, 0.5, 3], ["past the end", 116, 62, 2, 10], ["on the end", 108, 56, 1, 0]] as const)(
    "%s", (_n, x, y, t, d) => expect([paramOnSeg(p1, p2, { x, y }), distToSeg(p1, p2, { x, y })]).toEqual(near([t, d], 9)));
  it("treats a zero length segment as its point", () => {
    expect([paramOnSeg(p1, p1, { x: 103, y: 54 }), distToSeg(p1, p1, { x: 103, y: 54 })]).toEqual([0, 5]);
  });
});

describe("signedAngleDeg", () => {
  it.each([
    ["a turn left", ray(100, 50, 30), ray(120, 40, 75), 45],
    ["a turn right", ray(100, 50, 75), ray(120, 40, 30), -45],
    ["past 180 going left", ray(100, 50, -100), ray(120, 40, 80.5), -179.5],
    ["past 180 going right", ray(100, 50, 80.5), ray(120, 40, -100), 179.5],
  ] as const)("%s", (_n, l1, l2, want) => expect(signedAngleDeg(l1, l2)).toBeCloseTo(want, 9));
  it("gives 180, never -180, for opposite lines", () => {
    expect(signedAngleDeg(seg(110, 57, 100, 57), seg(100, 52, 120, 52))).toBe(180);
    expect(signedAngleDeg(seg(100, 52, 120, 52), seg(110, 57, 100, 57))).toBe(180);
  });
  it("folds two lines pointing just either side of the negative x axis to a small angle", () => {
    expect(signedAngleDeg(seg(100, 50, 99, 49.99), seg(100, 50, 99, 50.01))).toBeCloseTo(-(2 * Math.atan(0.01) * 180) / Math.PI, 9);
  });
});

describe("properties over seeded random inputs", () => {
  const rnd = mulberry32(20261022);
  const R = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const onCircle = (p: THREE.Vector2, c: THREE.Vector2, r: number) => Math.abs(p.distanceTo(c) - r);
  const offLine = (p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / a.distanceTo(b);

  it("puts every circle circle point on both circles, two of them when the circles cross", () => {
    const bad: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      const c1 = v(R(50, 150), R(20, 80)), c2 = v(R(50, 150), R(20, 80)), r1 = R(1, 40), r2 = R(1, 40);
      const d = c1.distanceTo(c2), pts = circleCircleIntersect(c1, r1, c2, r2);
      const want = d > r1 + r2 + 1e-6 || d < Math.abs(r1 - r2) - 1e-6 ? 0 : d < r1 + r2 - 1e-6 && d > Math.abs(r1 - r2) + 1e-6 ? 2 : pts.length;
      if (pts.length !== want || pts.some((p) => onCircle(p, c1, r1) > 1e-8 || onCircle(p, c2, r2) > 1e-8)) bad.push({ c1, r1, c2, r2, pts });
    }
    expect(bad).toEqual([]);
  });

  it("puts every circle line point on the circle and the line, two of them when the line cuts through", () => {
    const bad: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      const a = v(R(50, 150), R(20, 80)), b = v(R(50, 150), R(20, 80)), c = v(R(50, 150), R(20, 80)), r = R(1, 40);
      const dist = offLine(c, a, b), pts = circleLineIntersect(a, b, c, r), seg = segCircleIntersect(a, b, c, r);
      const want = dist > r + 1e-6 ? 0 : dist < r - 1e-6 ? 2 : pts.length;
      const inSeg = pts.filter((p) => { const t = paramOnSeg(a, b, p); return t >= 1e-6 && t <= 1 - 1e-6; });
      if (pts.length !== want || pts.some((p) => onCircle(p, c, r) > 1e-8 || offLine(p, a, b) > 1e-8) || seg.length !== inSeg.length) bad.push({ a, b, c, r, pts, seg });
    }
    expect(bad).toEqual([]);
  });

  it("returns a segment crossing exactly when the ends of each lie on opposite sides of the other", () => {
    const side = (a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const bad: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      const [a, b, c, d] = [0, 1, 2, 3].map(() => v(R(50, 150), R(20, 80))) as [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2];
      const crosses = side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
      const p = segIntersect(a, b, c, d);
      if (!!p !== crosses || (p && (distToSeg(a, b, p) > 1e-8 || distToSeg(c, d, p) > 1e-8))) bad.push({ a, b, c, d, p });
    }
    expect(bad).toEqual([]);
  });

  it("keeps signedAngleDeg in (-180, 180] and equal to the turn between the directions", () => {
    const bad: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      const l1 = ray(R(50, 150), R(20, 80), R(-180, 180)), l2 = ray(R(50, 150), R(20, 80), R(-180, 180));
      const d = signedAngleDeg(l1, l2);
      const turn = Math.atan2(l2.y2 - l2.y1, l2.x2 - l2.x1) - Math.atan2(l1.y2 - l1.y1, l1.x2 - l1.x1);
      if (!(d > -180 && d <= 180) || Math.abs(Math.cos((d * Math.PI) / 180) - Math.cos(turn)) > 1e-9 || Math.abs(Math.sin((d * Math.PI) / 180) - Math.sin(turn)) > 1e-9) bad.push({ l1, l2, d });
    }
    expect(bad).toEqual([]);
  });
});
