import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ConstraintTools, type ConstraintHost } from "../../src/sketch/constraintTools";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";
import type { SketchTool } from "../../src/sketch/sketchMode";

// Minimal live-accessor host mirroring what SketchMode provides. pickEntity
// (from modify.ts) is the real implementation, so clicks are aimed at geometry.
class MockHost implements ConstraintHost {
  _tool: SketchTool = "select";
  _ents: ResolvedEntity[] = [];
  _cons: SketchConstraint[] = [];
  _fillet: number | null = null;
  solves = 0;
  tool() { return this._tool; }
  entities() { return this._ents; }
  constraints() { return this._cons; }
  pickTol() { return 1; }
  getFilletFirst() { return this._fillet; }
  setFilletFirst(i: number | null) { this._fillet = i; }
  requestSolve() { this.solves++; }
  warnings: string[] = [];
  warn(msg: string) { this.warnings.push(msg); }
}

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe("constraintTools click flows (Tier 1 additions)", () => {
  it("equal on two lines emits an `equal` constraint", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    h._tool = "equal";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0)); // first line body
    ct.click(v(5, 5)); // second line body
    expect(h._cons).toEqual([{ type: "equal", l1: "l1", l2: "l2" }]);
  });

  it("equal on two circles emits `equalRadius` (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 3, x: 20, y: 0 },
    ];
    h._tool = "equal";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));  // on c1 rim
    ct.click(v(23, 0)); // on c2 rim
    expect(h._cons).toEqual([{ type: "equalRadius", a: "c1", b: "c2" }]);
  });

  it("tangent on a line + circle emits the general `tangent2` (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: -10, y1: 5, x2: 10, y2: 5 },
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    ];
    h._tool = "tangent";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 5)); // line
    ct.click(v(5, 0)); // circle rim
    expect(h._cons).toEqual([{ type: "tangent2", a: "l1", b: "c1" }]);
  });

  it("tangent refuses two lines", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    h._tool = "tangent";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));
    ct.click(v(5, 5));
    expect(h._cons).toEqual([]);
  });

  it("concentric accepts circles (and the same path serves arcs)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 8, x: 0, y: 0 },
    ];
    h._tool = "concentric";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0)); // c1 rim
    ct.click(v(8, 0)); // c2 rim
    expect(h._cons).toEqual([{ type: "concentric", c1: "c1", c2: "c2" }]);
  });

  it("collinear on two lines emits a `collinear` constraint (NEW)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 20, y1: 2, x2: 30, y2: 2 },
    ];
    h._tool = "collinear";
    const ct = new ConstraintTools(h);
    ct.click(v(5, 0));
    ct.click(v(25, 2));
    expect(h._cons).toEqual([{ type: "collinear", l1: "l1", l2: "l2" }]);
  });

  it("fix pins the nearest point, a circle center → {fix, p:0} (NEW)", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 0, y: 0 }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0)); // at the center
    expect(h._cons).toEqual([{ type: "fix", e: "c1", p: 0 }]);
  });

  it("fix on a line endpoint records that endpoint index", () => {
    const h = new MockHost();
    h._ents = [{ type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0)); // the end (index 1)
    expect(h._cons).toEqual([{ type: "fix", e: "l1", p: 1 }]);
  });

  it("fix on projected geometry adds nothing and warns (it is already fixed)", () => {
    const h = new MockHost();
    h._ents = [{
      type: "projected", id: "p1",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    }];
    h._tool = "fix";
    const ct = new ConstraintTools(h);
    ct.click(v(10, 0));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/Break Link/);
  });
});

describe("constraint click flows: rectangle sides, point on curve, refusals", () => {
  const rect: ResolvedEntity = { type: "rectangle", id: "Q", x: 0, y: 30, width: 20, height: 10 };
  const line: ResolvedEntity = { type: "line", id: "S", x1: 0, y1: 0, x2: 30, y2: 3 };

  it("parallel takes a line, then a rectangle side", () => {
    const h = new MockHost();
    h._ents = [line, rect];
    h._tool = "parallel";
    const ct = new ConstraintTools(h);
    ct.click(v(15, 1.5));
    ct.click(v(0, 25)); // bottom side, y = 25
    expect(h._cons).toEqual([{ type: "parallel", l1: "S", l2: "Q~0" }]);
    expect(h._fillet).toBeNull();
  });

  it("tangent on two lines says why instead of doing nothing", () => {
    const h = new MockHost();
    h._ents = [line, { type: "line", id: "T", x1: 0, y1: 10, x2: 30, y2: 10 }];
    h._tool = "tangent";
    const ct = new ConstraintTools(h);
    ct.click(v(15, 1.5));
    ct.click(v(15, 10));
    expect(h._cons).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/cannot be tangent/);
  });

  it("coincident from a point onto a curve body records point on curve", () => {
    const h = new MockHost();
    h._ents = [line, { type: "point", id: "P", x: 40, y: 40 }, { type: "circle", id: "C", x: 60, y: 0, radius: 5 }];
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(40, 40));
    ct.click(v(15, 1.5));
    ct.click(v(40, 40));
    ct.click(v(65, 0));
    expect(h._cons).toEqual([
      { type: "pointOnCurve", e: "P", p: 0, curve: "S" },
      { type: "pointOnCurve", e: "P", p: 0, curve: "C" },
    ]);
  });

  it("midpoint takes a point, then a rectangle side", () => {
    const h = new MockHost();
    h._ents = [rect, { type: "point", id: "P", x: 40, y: 40 }];
    h._tool = "midpoint";
    const ct = new ConstraintTools(h);
    ct.click(v(40, 40));
    ct.click(v(0, 35)); // top side, y = 35
    expect(h._cons).toEqual([{ type: "midpoint", e: "P", p: 0, line: "Q~2" }]);
  });
});
