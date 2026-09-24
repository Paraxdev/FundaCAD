import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ConstraintTools, type ConstraintHost } from "../../src/sketch/constraintTools";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";
import type { SketchTool } from "../../src/sketch/sketchMode";

// Same MockHost shape as constraintTools.test.ts: a live-accessor host, no DOM.
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
const labels = (opts: { label: string }[]) => opts.map((o) => o.label).sort();

describe("ConstraintTools.applicable (SK-3: selection-driven constraint menu)", () => {
  it("a circle centre + a point entity resolve to Coincident (no click position needed)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "point", id: "p1", x: 20, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }, { id: "p1" }]);
    expect(labels(opts)).toEqual(["Coincident"]);
    opts[0]!.apply();
    expect(h._cons).toEqual([{ type: "coincident", e1: "c1", p1: 0, e2: "p1", p2: 0 }]);
    expect(h.solves).toBe(1);
  });

  it("a whole rectangle (4 corners) selected with no click position does not offer Coincident", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "rectangle", id: "r1", x: 20, y: 0, width: 10, height: 10 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }, { id: "r1" }]);
    expect(opts).toEqual([]);
  });

  it("a resolved rectangle corner (from a click position) + a circle centre DOES offer Coincident", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "rectangle", id: "r1", x: 20, y: 0, width: 10, height: 10 },
    ];
    const ct = new ConstraintTools(h);
    // corner index 1 is (25, -5) per rectCorners' CCW order from (x-hw,y-hh)
    const opts = ct.applicable([{ id: "c1" }, { id: "r1", p: 1 }]);
    expect(labels(opts)).toEqual(["Coincident"]);
    opts[0]!.apply();
    expect(h._cons).toEqual([{ type: "coincident", e1: "c1", p1: 0, e2: "r1", p2: 1 }]);
  });

  it("two lines offer Parallel/Perpendicular/Equal/Collinear, never Tangent", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "l1" }, { id: "l2" }]);
    expect(labels(opts)).toEqual(["Collinear", "Equal", "Parallel", "Perpendicular"]);
  });

  it("two circles offer Concentric/Equal/Tangent, never Coincident", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 8, x: 20, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }, { id: "c2" }]);
    expect(labels(opts)).toEqual(["Concentric", "Equal", "Tangent"]);
    const concentric = opts.find((o) => o.label === "Concentric")!;
    concentric.apply();
    expect(h._cons).toEqual([{ type: "concentric", c1: "c1", c2: "c2" }]);
  });

  it("a line + a circle offer only Tangent", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: -10, y1: 5, x2: 10, y2: 5 },
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "l1" }, { id: "c1" }]);
    expect(labels(opts)).toEqual(["Tangent"]);
  });

  it("a single native line offers Horizontal/Vertical, a projected line offers neither", () => {
    const h = new MockHost();
    h._ents = [{ type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 3 }];
    const ct = new ConstraintTools(h);
    expect(labels(ct.applicable([{ id: "l1" }]))).toEqual(["Horizontal", "Vertical"]);

    const h2 = new MockHost();
    h2._ents = [{
      type: "projected", id: "p1",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    }];
    const ct2 = new ConstraintTools(h2);
    expect(ct2.applicable([{ id: "p1" }])).toEqual([]);
  });

  it("a single circle offers Fix at its centre; a single rectangle with no resolved corner offers nothing", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 3, y: 4 }];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }]);
    expect(labels(opts)).toEqual(["Fix"]);
    opts[0]!.apply();
    expect(h._cons).toEqual([{ type: "fix", e: "c1", p: 0 }]);

    const h2 = new MockHost();
    h2._ents = [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 10, height: 10 }];
    const ct2 = new ConstraintTools(h2);
    expect(ct2.applicable([{ id: "r1" }])).toEqual([]);
  });

  it("a resolved rectangle corner offers Fix for that corner", () => {
    const h = new MockHost();
    h._ents = [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 10, height: 10 }];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "r1", p: 2 }]);
    expect(labels(opts)).toEqual(["Fix"]);
    opts[0]!.apply();
    expect(h._cons).toEqual([{ type: "fix", e: "r1", p: 2 }]);
  });

  it("empty, single unknown id, or more than two picks yield no options", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 0, y: 0 }];
    const ct = new ConstraintTools(h);
    expect(ct.applicable([])).toEqual([]);
    expect(ct.applicable([{ id: "nope" }])).toEqual([]);
    expect(ct.applicable([{ id: "c1" }, { id: "c1" }])).toEqual([]); // same entity twice
  });
});

describe("ConstraintTools.resolvePoint (the pickEndpoint/circle gap SK-3 needed closed)", () => {
  it("finds a circle's centre (missing from the old hand-rolled endpoint scanner)", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 3, y: 4 }];
    const ct = new ConstraintTools(h);
    expect(ct.resolvePoint(v(3, 4))).toEqual({ id: "c1", idx: 0 });
  });

  it("finds a rectangle corner", () => {
    const h = new MockHost();
    h._ents = [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 10, height: 10 }];
    const ct = new ConstraintTools(h);
    const hit = ct.resolvePoint(v(5, -5));
    expect(hit?.id).toBe("r1");
    expect(hit?.idx).toBeGreaterThanOrEqual(0);
    expect(hit?.idx).toBeLessThanOrEqual(3);
  });

  it("the raw Coincident click flow now reaches a circle centre end to end", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "point", id: "p1", x: 20, y: 0 },
    ];
    h._tool = "coincident";
    const ct = new ConstraintTools(h);
    ct.click(v(0, 0)); // circle centre, unreachable before the pickEndpoint fix
    ct.click(v(20, 0)); // point entity
    expect(h._cons).toEqual([{ type: "coincident", e1: "c1", p1: 0, e2: "p1", p2: 0 }]);
  });
});
