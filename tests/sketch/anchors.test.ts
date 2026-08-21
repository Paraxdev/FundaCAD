// The middle of the face you are sketching on.
//
// The report: select a face, sketch on it, and the grid's origin and the axis
// arrows are off where the world origin projects, with nothing on the face to
// aim at. These pin the anchors the face itself contributes.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  footprintAnchors,
  isDegenerateLoop,
  loopCentroid,
  signedArea2,
} from "../../src/sketch/anchors";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const rect = (cx: number, cy: number, w: number, h: number) => [
  v(cx - w / 2, cy - h / 2),
  v(cx + w / 2, cy - h / 2),
  v(cx + w / 2, cy + h / 2),
  v(cx - w / 2, cy + h / 2),
];
const circle = (cx: number, cy: number, r: number, n = 64, cw = false) =>
  Array.from({ length: n }, (_, i) => {
    const t = ((cw ? -1 : 1) * 2 * Math.PI * i) / n;
    return v(cx + r * Math.cos(t), cy + r * Math.sin(t));
  });

describe("loopCentroid", () => {
  it("finds the centre of a rectangle wherever it sits", () => {
    const c = loopCentroid(rect(20, -7, 8, 30))!;
    expect(c.x).toBeCloseTo(20, 9);
    expect(c.y).toBeCloseTo(-7, 9);
  });

  it("finds the centre of a round face however unevenly it was sampled", () => {
    // THE reason this is the area centroid and not the average of the vertices.
    // A tessellated face carries far more points along its arc than down its
    // straight sides, and a vertex average is dragged toward whichever part was
    // sampled hardest. Here: a semicircle at 200 samples closed by ONE straight
    // chord, which is exactly that lopsidedness.
    const half = Array.from({ length: 201 }, (_, i) => {
      const t = (Math.PI * i) / 200;
      return v(5 * Math.cos(t), 5 * Math.sin(t));
    });
    const c = loopCentroid(half)!;
    // the true centroid of a semicircular area: 4r/3pi above the chord
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo((4 * 5) / (3 * Math.PI), 3);
    // and the vertex average, which is what a naive version would return
    const avgY = half.reduce((s, p) => s + p.y, 0) / half.length;
    expect(Math.abs(avgY - c.y)).toBeGreaterThan(0.15);
  });

  it("does not care which way round the loop was traced", () => {
    const ccw = loopCentroid(circle(3, 4, 2))!;
    const cw = loopCentroid(circle(3, 4, 2, 64, true))!;
    expect(ccw.x).toBeCloseTo(cw.x, 9);
    expect(ccw.y).toBeCloseTo(cw.y, 9);
    expect(Math.sign(signedArea2(circle(3, 4, 2)))).toBe(
      -Math.sign(signedArea2(circle(3, 4, 2, 64, true))),
    );
  });

  it("falls back to the vertex average for a loop with no area", () => {
    const line = [v(0, 0), v(10, 0), v(20, 0)];
    const c = loopCentroid(line)!;
    expect(c.x).toBeCloseTo(10, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });

  it("returns null rather than a NaN anchor", () => {
    expect(loopCentroid([])).toBeNull();
    expect(loopCentroid([v(0, 0), v(NaN, 1), v(2, 2)])).toBeNull();
  });
});

describe("footprintAnchors", () => {
  it("offers the face centre and every hole centre", () => {
    // A 40x40 face with two holes — the shape the report was made on.
    const anchors = footprintAnchors([
      rect(0, 0, 40, 40),
      circle(-10, 8, 3),
      circle(12, -6, 2),
    ]);
    expect(anchors).toHaveLength(3);
    const at = (x: number, y: number) =>
      anchors.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6);
    expect(at(0, 0)).toBe(true);
    expect(at(-10, 8)).toBe(true);
    expect(at(12, -6)).toBe(true);
  });

  it("skips slivers, which have no middle worth offering", () => {
    // A seam traced out and back has vertices and a bounding box and encloses
    // nothing. Its "centre" is a point in the middle of a line, and putting a
    // snap target there would make a mark on the face that is not a feature of
    // it. CONTROL: a genuinely thin but real 0.2 x 40 rib is kept.
    const seam = [v(0, 0), v(50, 0), v(0, 0)];
    expect(isDegenerateLoop(seam)).toBe(true);
    expect(footprintAnchors([seam])).toEqual([]);

    const rib = rect(0, 0, 0.2, 40);
    expect(isDegenerateLoop(rib)).toBe(false);
    expect(footprintAnchors([rib])).toHaveLength(1);
  });

  it("gives nothing for a plane with no model in it", () => {
    // A sketch on a datum plane. The face anchors have to be absent, not a
    // point at the origin, which is already the thing the report is about.
    expect(footprintAnchors([])).toEqual([]);
  });
});
