import { describe, it, expect } from "vitest";
import { arcSweep, FULL_SWEEP, type Cylinder } from "../../src/features/planeMath";
import type { Vec3 } from "../../src/types";

const cyl: Cylinder = { axis: [0, 0, 1], point: [0, 0, 0], radius: 2 };

// Points on the cylinder at the given angles, at two heights, as a tessellation has them.
const at = (c: Cylinder, angles: number[]): Vec3[] => {
  const [ax, ay, az] = c.axis;
  const u: Vec3 = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = u[0] * ax + u[1] * ay + u[2] * az;
  const uu: Vec3 = [u[0] - k * ax, u[1] - k * ay, u[2] - k * az];
  const n = Math.hypot(...uu);
  const e1: Vec3 = [uu[0] / n, uu[1] / n, uu[2] / n];
  const e2: Vec3 = [ay * e1[2] - az * e1[1], az * e1[0] - ax * e1[2], ax * e1[1] - ay * e1[0]];
  const out: Vec3[] = [];
  for (const h of [0, 5]) {
    for (const a of angles) {
      const ca = Math.cos(a) * c.radius, sa = Math.sin(a) * c.radius;
      out.push([
        c.point[0] + e1[0] * ca + e2[0] * sa + ax * h,
        c.point[1] + e1[1] * ca + e2[1] * sa + ay * h,
        c.point[2] + e1[2] * ca + e2[2] * sa + az * h,
      ]);
    }
  }
  return out;
};
const span = (from: number, to: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);

describe("arcSweep", () => {
  it("reads a half cylinder as pi", () => {
    expect(arcSweep(cyl, at(cyl, span(0, Math.PI, 12)))).toBeCloseTo(Math.PI, 9);
  });

  it("reads a quarter as pi/2", () => {
    expect(arcSweep(cyl, at(cyl, span(0.3, 0.3 + Math.PI / 2, 6)))).toBeCloseTo(Math.PI / 2, 9);
  });

  it("calls a 24 point ring full though its tessellation leaves a gap", () => {
    const ring = span(0, 2 * Math.PI, 24).slice(0, -1);
    const sweep = arcSweep(cyl, at(cyl, ring));
    expect(sweep).toBeLessThan(2 * Math.PI);
    expect(sweep).toBeGreaterThan(FULL_SWEEP);
  });

  it("does not call three quarters full", () => {
    expect(arcSweep(cyl, at(cyl, span(0, 1.5 * Math.PI, 18)))).toBeLessThan(FULL_SWEEP);
  });

  it("measures around a tilted axis off the origin, across the seam angle", () => {
    const c: Cylinder = { axis: [0, Math.SQRT1_2, Math.SQRT1_2], point: [3, -2, 7], radius: 4 };
    expect(arcSweep(c, at(c, span(Math.PI * 0.75, Math.PI * 1.25, 8)))).toBeCloseTo(Math.PI / 2, 9);
  });

  it("gives 0 with fewer than two usable points", () => {
    expect(arcSweep(cyl, [])).toBe(0);
    expect(arcSweep(cyl, [[0, 0, 4]])).toBe(0);
  });
});
