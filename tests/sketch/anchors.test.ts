// The middle of the face you are sketching on.
//
// The report: select a face, sketch on it, and the grid's origin and the axis
// arrows are off where the world origin projects, with nothing on the face to
// aim at. These pin the anchors the face itself contributes.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  boundaryAnchors,
  footprintAnchors,
  isClosedPoly,
  isDegenerateLoop,
  loopCentroid,
  polylineMidpoint,
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

// --- the edge of the face --------------------------------------------------
//
// "Centred on this face" was a gesture; "level with that corner" and "centred
// on this side" were arithmetic. These pin the anchors the face's OUTLINE
// contributes, which arrive as one polyline per B-rep edge in the plane.

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / n;
    return v(cx + r * Math.cos(t), cy + r * Math.sin(t));
  });

/** the four sides of an axis-aligned rectangle, as separate edges */
const rectEdges = (cx: number, cy: number, w: number, h: number) => {
  const c = rect(cx, cy, w, h);
  return c.map((p, i) => [p, c[(i + 1) % 4]!]);
};

describe("polylineMidpoint", () => {
  it("is half way along the CURVE, not half way along the chord", () => {
    // The middle of a curved side is the point you would put a hole at. On a
    // quarter circle the chord midpoint sits a sagitta inside the material —
    // 0.29 r on a 90 degree arc, which on a 20mm fillet is 5.9mm of daylight.
    const quarter = arc(0, 0, 10, 0, Math.PI / 2, 32);
    const mid = polylineMidpoint(quarter)!;
    expect(mid.length()).toBeCloseTo(10, 2); // on the arc
    const a = quarter[0]!;
    const b = quarter[quarter.length - 1]!;
    const chordMid = a.clone().add(b).multiplyScalar(0.5);
    // CONTROL: the chord midpoint is NOT on the arc, so the two answers differ
    // by an amount that matters.
    expect(chordMid.length()).toBeLessThan(9);
    expect(mid.distanceTo(chordMid)).toBeGreaterThan(1);
  });

  it("is the middle of a straight side", () => {
    expect(polylineMidpoint([v(0, 0), v(10, 0)])!.x).toBeCloseTo(5, 9);
    // and unaffected by how densely that side happens to be sampled
    const dense = [v(0, 0), v(1, 0), v(2, 0), v(9, 0), v(10, 0)];
    expect(polylineMidpoint(dense)!.x).toBeCloseTo(5, 9);
  });

  it("has no answer for a polyline with no length", () => {
    expect(polylineMidpoint([v(3, 3), v(3, 3)])).toBeNull();
    expect(polylineMidpoint([v(3, 3)])).toBeNull();
    expect(polylineMidpoint([])).toBeNull();
  });
});

describe("boundaryAnchors", () => {
  it("gives a rectangular face four corners and four side middles", () => {
    const { corners, sides } = boundaryAnchors(rectEdges(0, 0, 40, 20));
    expect(corners).toHaveLength(4);
    expect(sides).toHaveLength(4);
    const cs = corners.map((p) => [p.x, p.y].join()).sort();
    expect(cs).toEqual(["-20,-10", "-20,10", "20,-10", "20,10"].sort());
    const ms = sides.map((p) => [p.x, p.y].join()).sort();
    expect(ms).toEqual(["-20,0", "0,-10", "0,10", "20,0"].sort());
  });

  it("counts a shared corner once", () => {
    // Every corner belongs to two edges and therefore arrives twice. Four
    // anchors, not eight: two snap targets in the same place are one target
    // that costs twice as much to consider.
    const { corners } = boundaryAnchors(rectEdges(5, 5, 10, 10));
    expect(corners).toHaveLength(4);
  });

  it("offers no corner at a circle's seam", () => {
    // A hole arrives as ONE closed edge whose ends meet at the seam, which is
    // where the kernel happened to start parameterising it. A corner there
    // would put a snap target at three o'clock on every hole in the part, for a
    // reason nothing on screen could explain. Its centre is an anchor already
    // (footprintAnchors); this is about not inventing a second one.
    const hole = circle(3, 4, 5, 48);
    const { corners, sides } = boundaryAnchors([[...hole, hole[0]!]]);
    expect(corners).toEqual([]);
    expect(sides).toEqual([]);
    // CONTROL: the same samples as an OPEN arc are a real side, and do get one.
    const open = boundaryAnchors([hole]);
    expect(open.corners.length).toBeGreaterThan(0);
    expect(open.sides).toHaveLength(1);
  });

  it("puts a rounded corner's anchors on the arc, not where the corner was", () => {
    // A filleted rectangle: the sharp corner is gone, so nothing may claim it
    // is still there. What the face has instead is the arc's two ends and its
    // middle, all of which are on the material.
    const r = 4;
    const round = arc(16 - r, 8 - r, r, 0, Math.PI / 2, 12);
    const side = [v(-16, 8), v(16 - r, 8)];
    const { corners, sides } = boundaryAnchors([round, side]);
    for (const p of [...corners, ...sides]) {
      expect(Math.hypot(p.x, p.y), `${p.x},${p.y}`).toBeLessThan(18);
      // CONTROL: the vanished sharp corner is at (16, 8) and nothing is there.
      expect(p.distanceTo(v(16, 8))).toBeGreaterThan(0.5);
    }
    expect(sides).toHaveLength(2);
  });

  it("gives nothing for a plane with no model in it", () => {
    expect(boundaryAnchors([])).toEqual({ corners: [], sides: [] });
    expect(boundaryAnchors([[v(1, 1)]])).toEqual({ corners: [], sides: [] });
  });

  it("survives a degenerate edge without inventing a point", () => {
    const { corners, sides } = boundaryAnchors([[v(2, 2), v(2, 2)]]);
    expect(corners).toHaveLength(1); // it IS a point on the model
    expect(sides).toEqual([]); // but it has no middle
  });
});

describe("isClosedPoly", () => {
  it("needs more than two points to be a loop", () => {
    // An edge drawn out and back is not a circle; without this a two-point
    // degenerate edge would read as closed and lose its corner.
    expect(isClosedPoly([v(0, 0), v(0, 0)], 1e-9)).toBe(false);
    expect(isClosedPoly([v(0, 0), v(1, 0), v(0, 0)], 1e-9)).toBe(true);
  });
});
