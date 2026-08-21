import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { snap, candidatesFromEntities, type SnapCandidate } from "../../src/sketch/snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const screen = (p: THREE.Vector2) => ({ x: p.x, y: p.y }); // 1px = 1 unit for the test

describe("snap", () => {
  const cands: SnapCandidate[] = [
    { p: v(10, 0), kind: "endpoint", priority: 100 },
    { p: v(10.3, 0), kind: "midpoint", priority: 80 },
  ];
  it("snaps to a candidate within pixel tolerance, higher priority winning", () => {
    const r = snap(v(10.2, 0), cands, screen, 1, 10);
    expect(r.kind).toBe("endpoint");
    expect(r.point.x).toBe(10);
  });
  it("falls back to the grid when no candidate is near", () => {
    const r = snap(v(4.9, 5.1), [], screen, 5, 10);
    expect(r.kind).toBe("grid");
    expect(r.point.x).toBe(5);
    expect(r.point.y).toBe(5);
  });
  // The grid is made of LINES, and it used to snap only to where two of them
  // cross: both axes were rounded and then one distance was measured to the
  // resulting corner, so the cursor had to be within tolerance in both axes at
  // once. Between two intersections, on a grid line, nothing snapped, which is
  // most of a grid line.
  it("snaps to a grid line when only one axis is near it", () => {
    // 2px from the x = 100 line, and 40 units from any horizontal line: the
    // cursor is on the line and nowhere near a crossing.
    const r = snap(v(98, 130), [], screen, 100, 10);
    expect(r.kind).toBe("grid");
    expect(r.point.x).toBe(100); // pulled onto the line
    expect(r.point.y).toBe(130); // and left alone along it
  });

  it("snaps the other axis the same way", () => {
    const r = snap(v(130, 98), [], screen, 100, 10);
    expect(r.kind).toBe("grid");
    expect(r.point.x).toBe(130);
    expect(r.point.y).toBe(100);
  });

  it("still snaps to an intersection when both axes are near one", () => {
    // Which is now the case where both axes fired, rather than a separate rule.
    const r = snap(v(98, 103), [], screen, 100, 10);
    expect(r.kind).toBe("grid");
    expect(r.point.x).toBe(100);
    expect(r.point.y).toBe(100);
  });

  it("leaves a point that is near no grid line alone", () => {
    const r = snap(v(150, 160), [], screen, 100, 10);
    expect(r.kind).toBe("free");
    expect(r.point.x).toBe(150);
    expect(r.point.y).toBe(160);
  });

  it("measures the tolerance on SCREEN, through a rotated plane", () => {
    // Lock to Plane can be off, and then a sketch axis is not a screen axis. The
    // gap has to be the distance between the two projected points, not a
    // difference in screen x: at 45 degrees a 10-unit move along a sketch axis
    // is ~14px on screen and must fall outside a 10px tolerance.
    const k = Math.SQRT1_2;
    const rot = (p: THREE.Vector2) => ({ x: (p.x - p.y) * k, y: (p.x + p.y) * k });
    expect(snap(v(92, 130), [], rot, 100, 10).kind).toBe("grid"); // 8 units ~ 8px
    expect(snap(v(88, 130), [], rot, 100, 10).kind).toBe("free"); // 12 units ~ 12px
  });

  it("returns the raw point (free) when grid snapping is off", () => {
    const r = snap(v(3.3, 7.7), [], screen, 0, 10);
    expect(r.kind).toBe("free");
    expect(r.point.x).toBeCloseTo(3.3);
  });
  it("returns free when a candidate exists but is beyond tolerance", () => {
    const r = snap(v(100, 100), cands, screen, 0, 10);
    expect(r.kind).toBe("free");
  });
});

describe("candidatesFromEntities", () => {
  it("emits endpoints + midpoint for a line", () => {
    const c = candidatesFromEntities([{ type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 }]);
    expect(c).toHaveLength(3);
    expect(c.find((x) => x.kind === "midpoint")!.p.x).toBe(5);
  });
  it("emits 4 corners + center + 4 edge midpoints for a rectangle", () => {
    const c = candidatesFromEntities([{ type: "rectangle", id: "r", width: 20, height: 10, x: 0, y: 0 }]);
    expect(c.filter((x) => x.kind === "endpoint")).toHaveLength(4);
    expect(c.filter((x) => x.kind === "center")).toHaveLength(1);
    expect(c.filter((x) => x.kind === "midpoint")).toHaveLength(4);
  });
  it("emits the center for a circle and a strong point for a point", () => {
    expect(candidatesFromEntities([{ type: "circle", id: "c", radius: 5, x: 1, y: 2 }])[0]!.kind).toBe("center");
    const pt = candidatesFromEntities([{ type: "point", id: "p", x: 3, y: 4 }]);
    expect(pt[0]!.priority).toBe(110);
  });
  it("handles arc and spline fit points", () => {
    const arc = candidatesFromEntities([{ type: "arc", id: "a", x1: 0, y1: 0, x2: 4, y2: 0, mx: 2, my: 2 }]);
    expect(arc).toHaveLength(3);
    const sp = candidatesFromEntities([{ type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] }]);
    expect(sp).toHaveLength(3);
  });
});

describe("candidatesFromEntities — projected reference geometry", () => {
  it("a projected line snaps like a native one: endpoints 100, midpoint 80", () => {
    const c = candidatesFromEntities([{
      type: "projected", id: "p1",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    }]);
    expect(c.filter((x) => x.kind === "endpoint" && x.priority === 100)).toHaveLength(2);
    const mid = c.find((x) => x.kind === "midpoint")!;
    expect(mid.priority).toBe(80);
    expect(mid.p.x).toBe(5);
  });

  it("a projected circle exposes its center (90); a poly has strong ends and weak interior vertices", () => {
    const circle = candidatesFromEntities([{
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 3, y: 4, r: 5 },
    }]);
    expect(circle).toHaveLength(1);
    expect(circle[0]!.kind).toBe("center");
    expect(circle[0]!.priority).toBe(90);

    const poly = candidatesFromEntities([{
      type: "projected", id: "pp",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "poly", pts: [[0, 0], [1, 1], [2, 0], [3, 1]] },
    }]);
    expect(poly.filter((x) => x.priority === 100)).toHaveLength(2); // real ends
    expect(poly.filter((x) => x.priority === 60)).toHaveLength(2); // sample vertices
  });
});

// Alignment guides: lining the cursor up with an anchor it is NOT on.
//
// The gesture the user described is "move away from a point and see a line
// telling you that you are still level with it", which is what makes a
// symmetrical layout something you draw rather than something you compute. It
// sits between the two rules that were already there: over the grid, because a
// guide says something about the drawing while the lattice is only the fallback,
// and under a point, because when the cursor is ON an anchor that anchor is the
// answer.
describe("snap alignment guides", () => {
  const hole: SnapCandidate = { p: v(40, 25), kind: "center", priority: 70 };
  const corner: SnapCandidate = { p: v(-10, 90), kind: "endpoint", priority: 100 };

  it("adopts the anchor's x when the cursor is level with it in x", () => {
    // 3px off the anchor's column and 100 units away along it: nowhere near the
    // anchor itself, squarely on its vertical line.
    const r = snap(v(43, 125), [hole], screen, 0, 10);
    expect(r.kind).toBe("align");
    expect(r.point.x).toBe(40);
    expect(r.point.y).toBe(125); // and free along the guide
    expect(r.guides).toEqual([{ from: hole.p, axis: "x" }]);
  });

  it("adopts the anchor's y the same way", () => {
    const r = snap(v(-60, 27), [hole], screen, 0, 10);
    expect(r.kind).toBe("align");
    expect(r.point.x).toBe(-60);
    expect(r.point.y).toBe(25);
    expect(r.guides.map((g) => g.axis)).toEqual(["y"]);
  });

  it("lands on the crossing of two anchors' guides", () => {
    // The symmetry case: level with one hole, in line with a far corner. Both
    // guides are reported, because both are why the point is where it is.
    const r = snap(v(-7, 23), [hole, corner], screen, 0, 10);
    expect(r.kind).toBe("align");
    expect(r.point.x).toBe(-10); // the corner's column
    expect(r.point.y).toBe(25); // the hole's row
    expect(r.guides).toHaveLength(2);
    expect(r.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
  });

  it("beats the grid", () => {
    // On the anchor's column AND within reach of a lattice line. Without the
    // ordering the lattice would answer, and the guide the user was following
    // would vanish the moment it crossed one.
    const r = snap(v(42, 123), [hole], screen, 100, 10);
    expect(r.kind).toBe("align");
    expect(r.point.x).toBe(40);
  });

  it("loses to a point snap, and reports no guides when it does", () => {
    const r = snap(v(41, 26), [hole], screen, 0, 10);
    expect(r.kind).toBe("center");
    expect(r.point.x).toBe(40);
    expect(r.point.y).toBe(25);
    expect(r.guides).toEqual([]);
  });

  it("does not draw two zero-length guides through one anchor", () => {
    // 8 and 8 is inside tolerance on each axis but 11.3 away as a point, so the
    // point pass misses and BOTH alignment axes fire off the same anchor. The
    // right answer is still the anchor — reported as itself, with no guides,
    // rather than as an alignment with two lines of no length.
    const r = snap(v(48, 33), [hole], screen, 0, 10);
    expect(r.kind).toBe("center");
    expect(r.point.x).toBe(40);
    expect(r.point.y).toBe(25);
    expect(r.guides).toEqual([]);
  });

  it("takes the NEAREST anchor on each axis", () => {
    const near: SnapCandidate = { p: v(41, 0), kind: "endpoint", priority: 100 };
    const far: SnapCandidate = { p: v(35, 0), kind: "endpoint", priority: 100 };
    const r = snap(v(43, 400), [far, near], screen, 0, 10);
    expect(r.point.x).toBe(41);
  });

  it("stays out of the way when nothing lines up", () => {
    const r = snap(v(200, 200), [hole], screen, 0, 10);
    expect(r.kind).toBe("free");
    expect(r.guides).toEqual([]);
  });
});

