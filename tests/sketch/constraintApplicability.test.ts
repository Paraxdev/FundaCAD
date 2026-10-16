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
const pick = <T extends { label: string }>(opts: T[], label: string): T => {
  const o = opts.find((x) => x.label === label);
  if (!o) throw new Error(`no ${label} in ${opts.map((x) => x.label).join(", ")}`);
  return o;
};

describe("ConstraintTools.applicable (SK-3: selection-driven constraint menu)", () => {
  it("a circle centre + a point entity resolve to Coincident, alignment and on curve (no click position needed)", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "point", id: "p1", x: 20, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }, { id: "p1" }]);
    expect(labels(opts)).toEqual(["Align horizontally", "Align vertically", "Coincident", "On curve"]);
    pick(opts, "Coincident").apply();
    expect(h._cons).toEqual([{ type: "coincident", e1: "c1", p1: 0, e2: "p1", p2: 0 }]);
    expect(h.solves).toBe(1);
    pick(opts, "On curve").apply();
    expect(h._cons[1]).toEqual({ type: "pointOnCurve", e: "p1", p: 0, curve: "c1" });
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
    expect(labels(opts)).toEqual(["Align horizontally", "Align vertically", "Coincident", "On curve"]);
    pick(opts, "Coincident").apply();
    expect(h._cons).toEqual([{ type: "coincident", e1: "c1", p1: 0, e2: "r1", p2: 1 }]);
  });

  it("two lines offer Horizontal/Vertical/Parallel/Perpendicular/Equal/Collinear, never Tangent", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "l2", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "l1" }, { id: "l2" }]);
    expect(labels(opts)).toEqual(["Collinear", "Equal", "Horizontal", "Parallel", "Perpendicular", "Vertical"]);
    pick(opts, "Horizontal").apply();
    expect(h._cons).toEqual([{ type: "horizontal", line: "l1" }, { type: "horizontal", line: "l2" }]);
    expect(h.solves).toBe(1);
  });

  it("two circles offer Concentric/Equal/Tangent, never Coincident", () => {
    const h = new MockHost();
    h._ents = [
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
      { type: "circle", id: "c2", radius: 8, x: 20, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }, { id: "c2" }]);
    expect(labels(opts)).toEqual(["Align horizontally", "Align vertically", "Concentric", "Equal", "Tangent"]);
    const concentric = opts.find((o) => o.label === "Concentric")!;
    concentric.apply();
    expect(h._cons).toEqual([{ type: "concentric", c1: "c1", c2: "c2" }]);
  });

  it("a line + a circle offer Tangent and the centre on the line or at its midpoint", () => {
    const h = new MockHost();
    h._ents = [
      { type: "line", id: "l1", x1: -10, y1: 5, x2: 10, y2: 5 },
      { type: "circle", id: "c1", radius: 5, x: 0, y: 0 },
    ];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "l1" }, { id: "c1" }]);
    expect(labels(opts)).toEqual(["Centre at midpoint", "Centre on line", "Tangent"]);
    pick(opts, "Centre on line").apply();
    expect(h._cons).toEqual([{ type: "pointOnCurve", e: "c1", p: 0, curve: "l1" }]);
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

  it("a single circle offers Fix centre and Radius; a single rectangle with no resolved corner offers nothing", () => {
    const h = new MockHost();
    h._ents = [{ type: "circle", id: "c1", radius: 5, x: 3, y: 4 }];
    const ct = new ConstraintTools(h);
    const opts = ct.applicable([{ id: "c1" }]);
    expect(labels(opts)).toEqual(["Fix centre", "Radius"]);
    pick(opts, "Fix centre").apply();
    expect(h._cons).toEqual([{ type: "fix", e: "c1", p: 0 }]);
    pick(opts, "Radius").apply();
    expect(h._cons[1]).toEqual({ type: "radius", e: "c1", value: 5 });
    // a circle that already has a size is not offered a second one
    expect(labels(ct.applicable([{ id: "c1" }]))).toEqual(["Fix centre"]);

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

  it("empty, an unknown id, or the same entity twice yield no options", () => {
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

describe("ConstraintTools.applicable: point on curve, alignment, chains, rectangle sides", () => {
  const host = (ents: ResolvedEntity[]) => { const h = new MockHost(); h._ents = ents; return { h, ct: new ConstraintTools(h) }; };
  const L: ResolvedEntity = { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 };
  const P: ResolvedEntity = { type: "point", id: "P", x: 10, y: 10 };
  const A: ResolvedEntity = { type: "arc", id: "A", x1: 10, y1: 0, x2: -10, y2: 0, mx: 0, my: 10 };
  const C: ResolvedEntity = { type: "circle", id: "C", x: 50, y: 50, radius: 5 };

  it("a point and a line offer On curve and Midpoint", () => {
    const { h, ct } = host([L, P]);
    const opts = ct.applicable([{ id: "P" }, { id: "L" }]);
    expect(labels(opts)).toEqual(["Midpoint", "On curve"]);
    pick(opts, "On curve").apply();
    pick(opts, "Midpoint").apply();
    expect(h._cons).toEqual([
      { type: "pointOnCurve", e: "P", p: 0, curve: "L" },
      { type: "midpoint", e: "P", p: 0, line: "L" },
    ]);
  });

  it("a point and an arc or a circle offer On curve", () => {
    const { h, ct } = host([A, C, P]);
    pick(ct.applicable([{ id: "P" }, { id: "A" }]), "On curve").apply();
    pick(ct.applicable([{ id: "C" }, { id: "P" }]), "On curve").apply();
    expect(h._cons).toEqual([
      { type: "pointOnCurve", e: "P", p: 0, curve: "A" },
      { type: "pointOnCurve", e: "P", p: 0, curve: "C" },
    ]);
  });

  it("the first coincident option for a point and a circle is On curve, which the I key takes", () => {
    const { ct } = host([A, C, P]);
    for (const sel of [[{ id: "P" }, { id: "C" }], [{ id: "C" }, { id: "P" }]]) {
      expect(ct.applicable(sel).find((o) => o.tool === "coincident")?.label).toBe("On curve");
    }
  });

  it("a clicked line end and a line offer On curve and Midpoint for that end", () => {
    const M: ResolvedEntity = { type: "line", id: "M", x1: 5, y1: 20, x2: 15, y2: 30 };
    const { h, ct } = host([L, M]);
    pick(ct.applicable([{ id: "M", p: 0 }, { id: "L" }]), "On curve").apply();
    expect(h._cons).toEqual([{ type: "pointOnCurve", e: "M", p: 0, curve: "L" }]);
  });

  it("two points align horizontally or vertically", () => {
    const Q: ResolvedEntity = { type: "point", id: "Q", x: 30, y: 12 };
    const { h, ct } = host([P, Q]);
    const opts = ct.applicable([{ id: "P" }, { id: "Q" }]);
    pick(opts, "Align horizontally").apply();
    pick(opts, "Align vertically").apply();
    expect(h._cons).toEqual([
      { type: "horizontalPoints", e1: "P", p1: 0, e2: "Q", p2: 0 },
      { type: "verticalPoints", e1: "P", p1: 0, e2: "Q", p2: 0 },
    ]);
  });

  it("two points and a line offer Symmetric about the line", () => {
    const Q: ResolvedEntity = { type: "point", id: "Q", x: 10, y: -10 };
    const { h, ct } = host([L, P, Q]);
    const opts = ct.applicable([{ id: "P" }, { id: "L" }, { id: "Q" }]);
    expect(labels(opts)).toEqual(["Symmetric"]);
    opts[0]!.apply();
    expect(h._cons).toEqual([{ type: "symmetric", e1: "P", p1: 0, e2: "Q", p2: 0, line: "L" }]);
  });

  it("a single arc offers Fix centre, Fix start, Fix end and Radius", () => {
    const { h, ct } = host([A]);
    const opts = ct.applicable([{ id: "A" }]);
    expect(labels(opts)).toEqual(["Fix centre", "Fix end", "Fix start", "Radius"]);
    pick(opts, "Fix centre").apply();
    pick(opts, "Radius").apply();
    expect(h._cons).toEqual([{ type: "fix", e: "A", p: 2 }, { type: "radius", e: "A", value: 10 }]);
  });

  it("three lines chain Equal, Parallel and Collinear to the first in one step", () => {
    const l = (id: string, y: number): ResolvedEntity => ({ type: "line", id, x1: 0, y1: y, x2: 10 + y, y2: y + 1 });
    const { h, ct } = host([l("a", 0), l("b", 5), l("c", 9)]);
    const opts = ct.applicable([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(labels(opts)).toEqual(["Collinear", "Equal", "Horizontal", "Parallel", "Vertical"]);
    pick(opts, "Equal").apply();
    expect(h._cons).toEqual([{ type: "equal", l1: "a", l2: "b" }, { type: "equal", l1: "a", l2: "c" }]);
    expect(h.solves).toBe(1);
    pick(opts, "Parallel").apply();
    expect(h._cons.slice(2)).toEqual([{ type: "parallel", l1: "a", l2: "b" }, { type: "parallel", l1: "a", l2: "c" }]);
  });

  it("three circles chain Equal radius and Concentric", () => {
    const c = (id: string, x: number): ResolvedEntity => ({ type: "circle", id, x, y: 0, radius: 2 + x / 10 });
    const { h, ct } = host([c("a", 0), c("b", 20), c("c", 40)]);
    const opts = ct.applicable([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(labels(opts)).toEqual(["Align horizontally", "Align vertically", "Concentric", "Equal"]);
    pick(opts, "Equal").apply();
    expect(h._cons).toEqual([{ type: "equalRadius", a: "a", b: "b" }, { type: "equalRadius", a: "a", b: "c" }]);
  });

  it("three points chain Coincident", () => {
    const pt = (id: string, x: number): ResolvedEntity => ({ type: "point", id, x, y: x });
    const { h, ct } = host([pt("a", 0), pt("b", 1), pt("c", 2)]);
    pick(ct.applicable([{ id: "a" }, { id: "b" }, { id: "c" }]), "Coincident").apply();
    expect(h._cons).toEqual([
      { type: "coincident", e1: "a", p1: 0, e2: "b", p2: 0 },
      { type: "coincident", e1: "a", p1: 0, e2: "c", p2: 0 },
    ]);
  });

  it("a rectangle side is a line operand", () => {
    const Q: ResolvedEntity = { type: "rectangle", id: "Q", x: 0, y: 30, width: 20, height: 10 };
    const S: ResolvedEntity = { type: "line", id: "S", x1: 0, y1: 0, x2: 30, y2: 3 };
    const { h, ct } = host([Q, S, C, P]);
    const opts = ct.applicable([{ id: "Q~0" }, { id: "S" }]);
    expect(labels(opts)).toEqual(["Collinear", "Equal", "Parallel", "Perpendicular"]);
    pick(opts, "Parallel").apply();
    expect(h._cons).toEqual([{ type: "parallel", l1: "Q~0", l2: "S" }]);
    expect(labels(ct.applicable([{ id: "Q~1" }, { id: "C" }]))).toEqual(["Centre at midpoint", "Centre on line", "Tangent"]);
    pick(ct.applicable([{ id: "P" }, { id: "Q~2" }]), "On curve").apply();
    expect(h._cons[1]).toEqual({ type: "pointOnCurve", e: "P", p: 0, curve: "Q~2" });
    expect(ct.applicable([{ id: "Q~7" }, { id: "S" }])).toEqual([]);
  });

  it("every option names the tool a shortcut can apply it through", () => {
    const { ct } = host([L, P, C]);
    const tools = (ids: string[]) => ct.applicable(ids.map((id) => ({ id }))).map((o) => o.tool);
    expect(tools(["L"])).toEqual(["horizontal", "vertical"]);
    expect(tools(["P", "L"])).toEqual(["coincident", "midpoint"]);
    expect(tools(["C"])[0]).toBe("fix");
  });
});
