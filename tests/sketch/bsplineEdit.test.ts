import { describe, it, expect } from "vitest";
import { deletePole, insertPole, polygonParam, splineToBspline, type BsplineEntity } from "../../src/sketch/bsplineEdit";
import { bsplineNearestParam, bsplinePoint, bsplineRange, poleRef } from "../../src/sketch/bspline";
import { splinePolyline } from "../../src/sketch/spline";
import type { SketchConstraint } from "../../src/types";

const open: BsplineEntity = {
  type: "bspline", id: "b",
  poles: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 25, y: -10 }, { x: 40, y: 15 }, { x: 50, y: 0 }],
};
const ring: BsplineEntity = {
  type: "bspline", id: "b", closed: true,
  poles: [{ x: 0, y: -20 }, { x: 25, y: -18 }, { x: 30, y: 5 }, { x: 12, y: 28 }, { x: -15, y: 22 }, { x: -28, y: 0 }],
};

function sameCurve(a: BsplineEntity, b: BsplineEntity) {
  const [lo, hi] = bsplineRange(a);
  for (let i = 0; i <= 200; i++) {
    const t = lo + ((hi - lo) * i) / 200;
    const p = bsplinePoint(a, t), q = bsplinePoint(b, t);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-9);
  }
}

describe("inserting a pole", () => {
  it("on the curve keeps the curve and shifts the constraints on later poles", () => {
    const at = bsplinePoint(open, 1.4);
    const cons: SketchConstraint[] = [
      { type: "fix", e: "b", p: 0 },
      { type: "fix", e: "b", p: 1 },
      { type: "fix", e: "b", p: poleRef(3, 5) },
      { type: "p2pDistance", id: "d", e1: "b", p1: poleRef(1, 5), e2: "b", p2: 1, value: 9 },
    ];
    const r = insertPole(open, at, 0.5, cons, false)!;
    expect(r.entity.poles).toHaveLength(6);
    sameCurve(open, r.entity);
    // in span 1 of a cubic, poles 2 and 3 are rebuilt and lose their constraints,
    // pole 1 is copied as is and the last one moves up a place
    const fixes = r.constraints.filter((c) => c.type === "fix").map((c) => (c as { p: number }).p);
    expect(fixes).toEqual([0, 1]);
    const d = r.constraints.find((c) => c.type === "p2pDistance") as Extract<SketchConstraint, { type: "p2pDistance" }>;
    expect(d.p1).toBe(poleRef(1, 6));
    expect(d.p2).toBe(1);
  });

  it("on a closed curve's polygon leg keeps the curve", () => {
    const P = ring.poles[2]!, Q = ring.poles[3]!;
    const mid = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
    expect(polygonParam(ring, mid, 0.5)).not.toBeNull();
    const r = insertPole(ring, mid, 0.5, [])!;
    expect(r.entity.poles).toHaveLength(7);
    expect(r.entity.closed).toBe(true);
    sameCurve(ring, r.entity);
  });

  it("finds nothing away from the curve and polygon", () => {
    expect(insertPole(open, { x: 25, y: 60 }, 0.5, [])).toBeNull();
  });
});

describe("deleting a pole", () => {
  it("drops its constraints and renumbers the rest", () => {
    const cons: SketchConstraint[] = [
      { type: "fix", e: "b", p: poleRef(2, 5) },
      { type: "coincident", e1: "b", p1: poleRef(3, 5), e2: "l", p2: 0 },
      { type: "fix", e: "b", p: 1 },
    ];
    const r = deletePole(open, 2, cons)!;
    expect(r.entity.poles).toHaveLength(4);
    expect(r.constraints).toEqual([
      { type: "coincident", e1: "b", p1: poleRef(2, 4), e2: "l", p2: 0 },
      { type: "fix", e: "b", p: 1 },
    ]);
    expect(deletePole(r.entity, 1, [])).toBeNull(); // a cubic keeps four
  });
});

describe("Edit as Control Points", () => {
  const fit = [{ x: 0, y: 0 }, { x: 12, y: 18 }, { x: 30, y: 4 }, { x: 44, y: 22 }, { x: 60, y: 6 }];

  it("follows the spline as drawn and keeps its ends and their constraints", () => {
    const cons: SketchConstraint[] = [{ type: "fix", e: "s", p: 1 }];
    const r = splineToBspline({ type: "spline", id: "s", points: fit }, cons)!;
    expect(r.entity.type).toBe("bspline");
    expect(r.entity.id).toBe("s");
    expect(r.entity.poles[0]).toEqual(fit[0]);
    expect(r.entity.poles.at(-1)).toEqual(fit.at(-1));
    expect(r.constraints).toEqual(cons);
    for (const q of splinePolyline(fit, 24)) {
      const on = bsplinePoint(r.entity, bsplineNearestParam(r.entity, q));
      expect(Math.hypot(on.x - q.x, on.y - q.y)).toBeLessThan(0.2);
    }
  });

  it("turns a closed spline into a closed curve", () => {
    const loop = [...fit.slice(0, 4), fit[0]!];
    const r = splineToBspline({ type: "spline", id: "s", points: loop }, [{ type: "fix", e: "s", p: 0 }])!;
    expect(r.entity.closed).toBe(true);
    expect(r.constraints).toEqual([]);
  });
});
