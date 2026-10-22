// Geometry tied to a projected arc, against the real planegcs: the arc is rigid reference, never a conflict.
import { describe, it, expect, vi } from "vitest";
import type { Feature, SketchConstraint, SketchEntity } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { solveSketchFeature } from "../../src/sketch/headlessSolve";
import { arc, near, pa, pt, line } from "./solveFixtures";

// centre (150,60), radius 5, CCW from -0.4 rad to 2.2 rad, rounded to 6 decimals like an engine projection
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const at = (a: number) => [r6(150 + 5 * Math.cos(a)), r6(60 + 5 * Math.sin(a))] as const;
const Rp = pa("Rp", ...at(-0.4), ...at(2.2), ...at(0.9));
const onArc: SketchConstraint[] = [
  { type: "hDistance", e1: "Rp", p1: 2, e2: "q", p2: 0, value: 3 },
  { type: "pointOnCurve", e: "q", p: 0, curve: "Rp" },
];

describe("a projected arc", () => {
  it("on its own is neither over-defined nor in conflict", async () => {
    expect(await compileAndSolve([Rp], [])).toEqual({ entities: [Rp], dof: 0, ok: true, conflicts: [], overDefined: [] });
  });

  it("holds a point put on it without a conflict", async () => {
    const r = await compileAndSolve([Rp, pt("q", 154, 64)], onArc);
    expect(r).toEqual(near({ entities: [Rp, pt("q", 153, 64)], dof: 0, ok: true, conflicts: [], overDefined: [] }, 5));
  });

  it("holds a tangent line without a conflict", async () => {
    // b starts fixed at (140,72) with length 6; tangency to the arc settles its end
    const b = line("b", 140, 72, 146, 70);
    const r = await compileAndSolve([Rp, b], [{ type: "fix", e: "b", p: 0 }, { type: "distance", line: "b", value: 6 }, { type: "tangent2", a: "b", b: "Rp" }]);
    const s = r.entities[1] as Extract<typeof b, { type: "line" }>;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const centreToLine = Math.abs((150 - s.x1) * dy - (60 - s.y1) * dx) / Math.hypot(dx, dy);
    expect({ ...r, entities: [r.entities[0], { start: [s.x1, s.y1], length: Math.hypot(dx, dy), centreToLine }] }).toEqual(near({
      entities: [Rp, { start: [140, 72], length: 6, centreToLine: 5 }], dof: 0, ok: true, conflicts: [], overDefined: [],
    }, 5));
  });

  it("lets a dragged point slide along it", async () => {
    const r = await compileAndSolve([Rp, pt("q", 154, 63)], [onArc[1]!], { fromX: 154, fromY: 63, toX: 147, toY: 66 });
    const q = r.entities[1] as { x: number; y: number };
    expect({ ok: r.ok, conflicts: r.conflicts, overDefined: r.overDefined, rim: Math.hypot(q.x - 150, q.y - 60), up: q.y > 63 })
      .toEqual({ ok: true, conflicts: [], overDefined: [], rim: expect.closeTo(5, 6), up: true });
  });

  it("re-solves a document sketch whose dimension changed", async () => {
    const sketch: Extract<Feature, { type: "sketch" }> = {
      id: "f1", type: "sketch", plane: "XY",
      entities: [Rp as SketchEntity, { type: "point", id: "q", x: 154, y: 64 }],
      constraints: [{ ...onArc[0]!, value: 4 } as SketchConstraint, onArc[1]!],
    };
    const solved = await solveSketchFeature(sketch, {});
    expect(solved?.entities).toEqual(near([Rp, { type: "point", id: "q", x: 154, y: 63 }], 5));
  });
});

it("a user arc fixed at its centre and both ends holds a point put on it without a conflict", async () => {
  const c = Rp.type === "projected" && Rp.curve.kind === "arc" ? Rp.curve : null;
  const a = arc("Rp", c!.x1, c!.y1, c!.x2, c!.y2, c!.mx, c!.my);
  const fix: SketchConstraint[] = [0, 1, 2].map((p) => ({ type: "fix", e: "Rp", p }));
  const r = await compileAndSolve([a, pt("q", 154, 64)], [...fix, ...onArc]);
  expect(r).toEqual(near({ entities: [a, pt("q", 153, 64)], dof: 0, ok: true, conflicts: [], overDefined: [] }, 5));
});
