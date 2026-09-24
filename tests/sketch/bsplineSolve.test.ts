// Every pole of a control-point spline is a solver point, so any pole can take a
// constraint or a dimension, and a dimension bound to a parameter moves the pole.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { solveSketchFeature } from "../../src/sketch/headlessSolve";
import { dimRefPoints } from "../../src/sketch/entityDims";
import { poleRef } from "../../src/sketch/bspline";
import { recompute } from "../../src/params/engine";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { CadDocument, Feature } from "../../src/types";

type Bs = Extract<ResolvedEntity, { type: "bspline" }>;
const poles = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 25, y: -10 }, { x: 40, y: 15 }, { x: 50, y: 0 }];
const curve = (closed = false): Bs => ({ type: "bspline", id: "b", poles: poles.map((p) => ({ ...p })), ...(closed ? { closed } : {}) });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("bspline poles in the solver", () => {
  it("exposes every pole as a reference point, ends at 0 and 1", () => {
    const refs = dimRefPoints(curve());
    expect(refs.map((r) => r.p)).toEqual([0, 2, 3, 4, 1]);
    expect(refs[1]!.pos.x).toBe(10);
  });

  it("drives an interior pole with a point to point dimension", async () => {
    const r = await compileAndSolve([curve()], [
      { type: "fix", e: "b", p: 0 },
      { type: "p2pDistance", id: "d", e1: "b", p1: 0, e2: "b", p2: poleRef(2, 5), value: 40 },
    ]);
    expect(r.ok).toBe(true);
    const out = r.entities[0] as Bs;
    expect(out.poles[0]).toEqual({ x: 0, y: 0 });
    expect(dist(out.poles[0]!, out.poles[2]!)).toBeCloseTo(40, 6);
    expect(out.poles[1]).toEqual(poles[1]);
  });

  it("holds a fixed interior pole while another is dragged", async () => {
    const r = await compileAndSolve([curve(true)], [{ type: "fix", e: "b", p: poleRef(1, 5) }], { fromX: 25, fromY: -10, toX: 30, toY: -30 });
    const out = r.entities[0] as Bs;
    expect(out.poles[1]).toEqual(poles[1]);
    expect(dist(out.poles[2]!, { x: 30, y: -30 })).toBeLessThan(1e-6);
  });

  it("joins an open curve's end to a line, but never an interior pole", async () => {
    const line: ResolvedEntity = { type: "line", id: "l", x1: 50, y1: 0, x2: 50, y2: -20 };
    const other: ResolvedEntity = { type: "line", id: "m", x1: 10, y1: 20, x2: 0, y2: 30 };
    const r = await compileAndSolve([curve(), line, other], [], { fromX: 50, fromY: 0, toX: 55, toY: 5 });
    const [b, l, m] = r.entities as [Bs, Extract<ResolvedEntity, { type: "line" }>, Extract<ResolvedEntity, { type: "line" }>];
    expect(b.poles[4]!.x).toBeCloseTo(55, 6);
    expect(l.x1).toBeCloseTo(55, 6);
    expect(m.x1).toBe(10); // the interior pole sat on m's end without joining it
  });

  it("moves a pole when the parameter its dimension is bound to changes", async () => {
    const doc: CadDocument = {
      parameters: {},
      paramDefs: { reach: { expr: "30", value: 0, unit: "mm", target: { kind: "constraint", sketch: "s", constraint: "d" } } },
      features: [{
        id: "s", type: "sketch", plane: "XY",
        entities: [{ type: "bspline", id: "b", poles: poles.map((p) => ({ ...p })) }],
        constraints: [
          { type: "fix", e: "b", p: 0 },
          { type: "fix", e: "b", p: 1 },
          { type: "p2pDistance", id: "d", e1: "b", p1: 0, e2: "b", p2: poleRef(3, 5), value: 1 },
        ],
      }],
    };
    const sketch = () => doc.features[0] as Extract<Feature, { type: "sketch" }>;
    const poleAt = async (expr: string) => {
      doc.paramDefs!["reach"]!.expr = expr;
      recompute(doc);
      const solved = await solveSketchFeature(sketch(), doc.parameters);
      expect(solved).not.toBeNull();
      const b = solved!.entities[0] as Extract<Feature, { type: "sketch" }>["entities"][number] & { type: "bspline" };
      return b.poles.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    };
    const a = await poleAt("30");
    expect(dist(a[0]!, a[3]!)).toBeCloseTo(30, 6);
    const b = await poleAt("45");
    expect(dist(b[0]!, b[3]!)).toBeCloseTo(45, 6);
    expect(b[4]).toEqual(poles[4]);
  });
});
