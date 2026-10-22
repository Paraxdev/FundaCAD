// The relations drawing records, held by the solver: a snap names what it
// caught, a point on a curve stays there, and a fillet stays tangent.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { candidatesFromEntities, snap, type ResolvedEntity } from "../../src/sketch/snap";
import * as snapMod from "../../src/sketch/snap";
import * as modify from "../../src/sketch/modify";
import { asRound } from "../../src/sketch/entityDims";
import type { SketchConstraint } from "../../src/types";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
const byId = (ents: ResolvedEntity[], id: string) => ents.find((e) => e.id === id)!;
const toScreen = (p: THREE.Vector2) => ({ x: p.x * 10, y: -p.y * 10 }); // 10 px per mm
const perp = (px: number, py: number, l: ResolvedEntity) => {
  if (l.type !== "line") throw new Error("line");
  const dx = l.x2 - l.x1,
    dy = l.y2 - l.y1;
  return Math.abs((px - l.x1) * dy - (py - l.y1) * dx) / Math.hypot(dx, dy);
};

describe("a snap names what it caught", () => {
  const ents = [line("A", 0, 0, 40, 30)];
  it("a midpoint snap carries the line", () => {
    const r = snap(new THREE.Vector2(20.2, 15.1), candidatesFromEntities(ents), toScreen, 0);
    expect(r.kind).toBe("midpoint");
    expect(r.ref).toEqual({ entity: "A", at: "mid" });
  });
  it("an endpoint snap carries the end index", () => {
    const r = snap(new THREE.Vector2(39.8, 30.1), candidatesFromEntities(ents), toScreen, 0);
    expect(r.ref).toEqual({ entity: "A", at: 1 });
  });
  it("a cursor just off a diagonal line lands on it", () => {
    const curves = snapMod.curvesFromEntities(ents);
    // (8, 6) is on the line, nudged 0.12 mm (1.2 px) across it
    const r = snap(new THREE.Vector2(8 - 0.072, 6 + 0.096), candidatesFromEntities(ents), toScreen, 0, 10, curves);
    expect(r.kind).toBe("curve");
    expect(r.ref).toEqual({ entity: "A", at: "curve" });
    expect(perp(r.point.x, r.point.y, ents[0]!)).toBeLessThan(1e-9);
  });
  it("an endpoint is preferred over the curve through it", () => {
    const r = snap(
      new THREE.Vector2(0.2, 0.1),
      candidatesFromEntities(ents),
      toScreen,
      0,
      10,
      snapMod.curvesFromEntities(ents),
    );
    expect(r.kind).toBe("endpoint");
  });
  it("lands on a circle and on an arc only inside its sweep", () => {
    const c: ResolvedEntity[] = [
      { type: "circle", id: "C", x: 0, y: 0, radius: 10 },
      { type: "arc", id: "R", x1: 50, y1: 0, x2: 30, y2: 0, mx: 40, my: 10 }, // upper half round (40,0)
    ];
    const curves = snapMod.curvesFromEntities(c);
    const onC = snap(new THREE.Vector2(0, 10.3), [], toScreen, 0, 10, curves);
    expect(onC.ref).toEqual({ entity: "C", at: "curve" });
    expect(onC.point.length()).toBeCloseTo(10, 9);
    const onR = snap(new THREE.Vector2(40, 10.4), [], toScreen, 0, 10, curves);
    expect(onR.ref).toEqual({ entity: "R", at: "curve" });
    const offR = snap(new THREE.Vector2(40, -10.4), [], toScreen, 0, 10, curves);
    expect(offR.kind).toBe("free");
  });
});

describe("recorded relations hold after an edit", () => {
  it("a line started on a midpoint stays on it when the line grows", async () => {
    const ents = [line("A", 0, 0, 40, 0), line("B", 20, 0, 20, 30)];
    const base: SketchConstraint[] = [
      { type: "horizontal", line: "A" },
      { type: "fix", e: "A", p: 0 },
      { type: "distance", line: "A", value: 60 },
    ];
    const r = await compileAndSolve(ents, [...base, { type: "midpoint", e: "B", p: 0, line: "A" }]);
    const a = byId(r.entities, "A"),
      b = byId(r.entities, "B");
    if (a.type !== "line" || b.type !== "line") throw new Error("line");
    expect(Math.hypot(b.x1 - (a.x1 + a.x2) / 2, b.y1 - (a.y1 + a.y2) / 2)).toBeLessThan(1e-6);
  });

  it("pointOnCurve holds an end on a line, a circle and an arc through a drag", async () => {
    const ents: ResolvedEntity[] = [
      line("L", 0, 0, 40, 30),
      { type: "circle", id: "C", x: 100, y: 0, radius: 10 },
      { type: "arc", id: "R", x1: 50, y1: 50, x2: 30, y2: 50, mx: 40, my: 60 },
      line("P", 16, 12, 16, 40),
      line("Q", 100, 10, 120, 40),
      line("S", 40, 60, 60, 90),
    ];
    const fix: SketchConstraint[] = [
      { type: "fix", e: "L", p: 0 },
      { type: "fix", e: "L", p: 1 },
      { type: "fix", e: "C", p: 0 },
      { type: "radius", e: "C", value: 10 },
      { type: "fix", e: "R", p: 0 },
      { type: "fix", e: "R", p: 1 },
      { type: "fix", e: "R", p: 2 },
    ];
    const on: SketchConstraint[] = [
      { type: "pointOnCurve", e: "P", p: 0, curve: "L" },
      { type: "pointOnCurve", e: "Q", p: 0, curve: "C" },
      { type: "pointOnCurve", e: "S", p: 0, curve: "R" },
    ];
    // each drag pulls the held end itself away from its curve
    for (const drag of [
      { fromX: 16, fromY: 12, toX: 5, toY: 30 },
      { fromX: 100, fromY: 10, toX: 130, toY: 30 },
      { fromX: 40, fromY: 60, toX: 45, toY: 80 },
    ]) {
      const r = await compileAndSolve(ents, [...fix, ...on], drag);
      expect(r.ok).toBe(true);
      const P = byId(r.entities, "P"),
        Q = byId(r.entities, "Q"),
        S = byId(r.entities, "S");
      if (P.type !== "line" || Q.type !== "line" || S.type !== "line") throw new Error("line");
      expect(perp(P.x1, P.y1, byId(r.entities, "L"))).toBeLessThan(1e-6);
      expect(Math.abs(Math.hypot(Q.x1 - 100, Q.y1) - 10)).toBeLessThan(1e-6);
      const R = asRound(byId(r.entities, "R"))!;
      expect(Math.abs(Math.hypot(S.x1 - R.x, S.y1 - R.y) - R.r)).toBeLessThan(1e-6);
    }
  });

  it("a sketch fillet records its two tangencies and stays tangent when a line moves", async () => {
    const ents = [line("L1", 0, 0, 40, 0), line("L2", 40, 0, 40, 40)];
    const res = modify.filletCorner(ents, 0, 1, 10)!;
    const tangents = modify.filletTangents(ents, 0, 1, res);
    const arc = res[res.length - 1]!;
    expect(tangents).toEqual([
      { type: "tangent2", a: "L1", b: arc.id },
      { type: "tangent2", a: "L2", b: arc.id },
    ]);
    const fixA: SketchConstraint[] = [
      { type: "fix", e: "L1", p: 0 },
      { type: "horizontal", line: "L1" },
    ];
    const r = await compileAndSolve(res, [...fixA, ...tangents], { fromX: 40, fromY: 40, toX: 60, toY: 45 });
    const c = asRound(byId(r.entities, arc.id))!;
    // without the two tangencies L2's residual was 1.3176 mm
    expect(Math.abs(perp(c.x, c.y, byId(r.entities, "L1")) - c.r)).toBeLessThan(1e-6);
    expect(Math.abs(perp(c.x, c.y, byId(r.entities, "L2")) - c.r)).toBeLessThan(1e-6);
  });
});

describe("menu relations the solver holds", () => {
  const pt = (id: string, x: number, y: number): ResolvedEntity => ({ type: "point", id, x, y });
  const at = (ents: ResolvedEntity[], id: string) => {
    const e = byId(ents, id);
    if (e.type !== "point") throw new Error("point");
    return e;
  };

  it("two points aligned horizontally, then vertically, share a y, then an x", async () => {
    const ents = [pt("P", 0, 0), pt("Q", 30, 5)];
    const free = await compileAndSolve(ents, []);
    const h = await compileAndSolve(ents, [{ type: "horizontalPoints", e1: "P", p1: 0, e2: "Q", p2: 0 }]);
    expect(h.ok).toBe(true);
    expect(h.dof).toBe(free.dof - 1);
    expect(Math.abs(at(h.entities, "P").y - at(h.entities, "Q").y)).toBeLessThan(1e-9);
    const v = await compileAndSolve(ents, [{ type: "verticalPoints", e1: "P", p1: 0, e2: "Q", p2: 0 }]);
    expect(Math.abs(at(v.entities, "P").x - at(v.entities, "Q").x)).toBeLessThan(1e-9);
    expect(v.overDefined).toEqual([]);
  });

  it("a point held on a rectangle side, and a circle tangent to another side", async () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "Q", x: 0, y: 0, width: 20, height: 10 },
      pt("P", 4, -8),
      { type: "circle", id: "C", x: 30, y: 0, radius: 3 },
    ];
    const r = await compileAndSolve(ents, [
      { type: "pointOnCurve", e: "P", p: 0, curve: "Q~0" },
      { type: "tangent2", a: "Q~1", b: "C" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    const q = byId(r.entities, "Q"),
      c = byId(r.entities, "C");
    if (q.type !== "rectangle" || c.type !== "circle") throw new Error("shape");
    expect(Math.abs(at(r.entities, "P").y - (q.y - q.height / 2))).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs(c.x - (q.x + q.width / 2)) - c.radius)).toBeLessThan(1e-6);
  });

  it("a rectangle corner, a circle centre and a point each snap with their point index", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "Q", x: 0, y: 0, width: 20, height: 10 },
      { type: "circle", id: "C", x: 40, y: 0, radius: 3 },
      pt("P", 60, 0),
    ];
    const cand = candidatesFromEntities(ents);
    const refAt = (x: number, y: number) => snap(new THREE.Vector2(x, y), cand, toScreen, 0).ref;
    expect(refAt(10.1, 5.1)).toEqual({ entity: "Q", at: 2 });
    expect(refAt(40.1, 0.1)).toEqual({ entity: "C", at: 0 });
    expect(refAt(60.1, 0)).toEqual({ entity: "P", at: 0 });
  });
});

describe("the grid is preferred over a curve it lies on", () => {
  const ents = [line("A", 0, 0, 100, 0), line("D", 0, 0, 100, 100)];
  const curves = snapMod.curvesFromEntities(ents);

  it("a lattice point on a line is taken and still records the curve", () => {
    const r = snap(new THREE.Vector2(30.3, 0.2), [], toScreen, 5, 10, curves.slice(0, 1));
    expect(r.point.toArray()).toEqual([30, 0]);
    expect(r.ref).toEqual({ entity: "A", at: "curve" });
  });

  it("a lattice point on a diagonal is taken", () => {
    const r = snap(new THREE.Vector2(30.2, 29.8), [], toScreen, 5, 10, curves.slice(1));
    expect(r.point.toArray()).toEqual([30, 30]);
    expect(r.ref).toEqual({ entity: "D", at: "curve" });
  });

  it("a lattice that misses the curve leaves the cursor on the curve", () => {
    const r = snap(new THREE.Vector2(33.4, 0.3), [], toScreen, 5, 10, curves.slice(0, 1));
    expect(r.point.y).toBe(0);
    expect(r.point.x).toBeCloseTo(33.4, 9);
    expect(r.ref).toEqual({ entity: "A", at: "curve" });
  });
});
