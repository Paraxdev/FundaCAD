// Shape freedom from probe solves, on the real planegcs solver.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve, constraintIndexOf } from "../../src/sketch/sketchSolve";
import { shapeFreedom, type Freedom } from "../../src/sketch/freedom";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";
import { arc, circle, line, pl, pt } from "./solveFixtures";

const F = (x: boolean, y: boolean, size = false): Freedom => ({ x, y, size });
const FIXED = F(false, false);
const rect = (id: string, x: number, y: number, width: number, height: number, angle?: number): ResolvedEntity => ({
  type: "rectangle",
  id,
  x,
  y,
  width,
  height,
  ...(angle ? { angle } : {}),
});
const polygon: ResolvedEntity = { type: "polygon", id: "g", x: -31.4, y: 12.6, radius: 9.3, sides: 5, angle: 0.4 };

// A horizontal line held 22.1 above a fixed point: x1 and x2 stay free, y is set.
const heldLine: ResolvedEntity[] = [pt("o", -18.4, 9.6), line("h", 14.2, 31.7, 52.9, 31.7)];
const heldRules: SketchConstraint[] = [
  { type: "fix", e: "o", p: 0 },
  { type: "horizontal", line: "h" },
  { type: "vDistance", e1: "o", p1: 0, e2: "h", p2: 0, value: 22.1 },
];

describe("shapeFreedom", () => {
  it("a lone slanted line is free in X and Y", async () => {
    const r = await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5)], []);
    expect(r).toEqual(new Map([["a", F(true, true)]]));
  });

  it("an empty sketch has no rows", async () => {
    expect(await shapeFreedom([], [])).toEqual(new Map());
  });

  it("a horizontal line set in Y by a fixed point is free in X only, the point is fixed", async () => {
    const r = await shapeFreedom(heldLine, heldRules);
    expect(r).toEqual(
      new Map([
        ["o", FIXED],
        ["h", F(true, false)],
      ]),
    );
  });

  it("reads many shapes at once: fixed ends, a fixed centre, a projected line, a polygon, a tilted rectangle and free curves", async () => {
    const ents: ResolvedEntity[] = [
      line("both", -7.3, 18.9, 26.1, 4.4),
      circle("c", 27.3, -14.6, 8.4),
      pl("p", -40.2, -11.5, -12.7, 6.8),
      polygon,
      arc("ar", 61.2, 8.3, 48.6, 27.9, 63.5, 22.1),
      pt("q", 33.8, 41.6),
      rect("tilt", 71.4, -22.6, 14.5, 9.2, 0.35),
      {
        type: "spline",
        id: "sp",
        points: [
          { x: -14.2, y: -27.5 },
          { x: -3.6, y: -19.8 },
          { x: 8.9, y: -31.3 },
        ],
      },
    ];
    const cons: SketchConstraint[] = [
      { type: "fix", e: "both", p: 0 },
      { type: "fix", e: "both", p: 1 },
      { type: "fix", e: "c", p: 0 },
      { type: "fix", e: "sp", p: 0 },
    ];
    const r = await shapeFreedom(ents, cons);
    expect(r).toEqual(
      new Map([
        ["both", FIXED],
        ["c", F(false, false, true)],
        ["p", FIXED],
        ["ar", F(true, true, true)],
        ["q", F(true, true)],
        // a rotated rectangle compiles pinned rigid, so the solver holds it fixed
        ["tilt", FIXED],
        ["sp", F(true, true)],
      ]),
    );
  });

  it("a fully defined sketch reads every solved shape fixed and still skips the polygon", async () => {
    const ents: ResolvedEntity[] = [rect("r", 13.7, -8.2, 24.5, 11.3), line("l", -21.6, 5.9, -3.4, 17.2), polygon];
    const cons: SketchConstraint[] = [
      { type: "fix", e: "r", p: 0 },
      { type: "fix", e: "r", p: 2 },
      { type: "fix", e: "l", p: 0 },
      { type: "fix", e: "l", p: 1 },
    ];
    expect((await compileAndSolve(ents, cons)).dof).toBe(0);
    expect(await shapeFreedom(ents, cons)).toEqual(
      new Map([
        ["r", FIXED],
        ["l", FIXED],
      ]),
    );
  });

  it("a rectangle with one fixed corner is free in X and Y", async () => {
    const r = await shapeFreedom([rect("r", 13.7, -8.2, 24.5, 11.3)], [{ type: "fix", e: "r", p: 0 }]);
    expect(r).toEqual(new Map([["r", F(true, true)]]));
  });

  it("conflicting constraints give no result", async () => {
    const cons: SketchConstraint[] = [
      { type: "distance", line: "a", value: 14.5 },
      { type: "distance", line: "a", value: 27.25 },
    ];
    const ents = [line("a", 12.5, 7.25, 41.75, 23.5)];
    expect((await compileAndSolve(ents, cons)).conflicts.length).toBeGreaterThan(0);
    expect(await shapeFreedom(ents, cons)).toBeNull();
  });

  it("a newer sketch waiting drops the result, before the probes or between them", async () => {
    expect(await shapeFreedom(heldLine, heldRules, () => true)).toBeNull();
    let checks = 0;
    expect(await shapeFreedom(heldLine, heldRules, () => ++checks > 3)).toBeNull();
    expect(checks).toBe(4);
    checks = 0;
    expect(await shapeFreedom(heldLine, heldRules, () => ++checks > 5)).toEqual(
      new Map([
        ["o", FIXED],
        ["h", F(true, false)],
      ]),
    );
  });
});

describe("compileAndSolve probe", () => {
  it("holding a free direction lowers dof, holding a set one leaves it", async () => {
    const base = await compileAndSolve(heldLine, heldRules);
    expect(base.dof).toBe(2);
    const dofs = await Promise.all(
      (["x", "y", "size"] as const).map(
        async (axis) => (await compileAndSolve(heldLine, heldRules, undefined, { probe: { entity: "h", axis } })).dof,
      ),
    );
    expect(dofs).toEqual([0, 2, 2]);
  });

  it("holding a free radius lowers dof by one, a held centre is redundant", async () => {
    const ents = [circle("c", 27.3, -14.6, 8.4)];
    const cons: SketchConstraint[] = [{ type: "fix", e: "c", p: 0 }];
    const probe = async (axis: "x" | "y" | "size") =>
      (await compileAndSolve(ents, cons, undefined, { probe: { entity: "c", axis } })).dof;
    expect((await compileAndSolve(ents, cons)).dof).toBe(1);
    expect([await probe("x"), await probe("y"), await probe("size")]).toEqual([1, 1, 0]);
  });

  it("a probe that holds nothing leaves the pass exactly as the plain one", async () => {
    const ents = [...heldLine, polygon];
    const plain = await compileAndSolve(ents, heldRules);
    expect(await compileAndSolve(ents, heldRules, undefined, { probe: { entity: "g", axis: "x" } })).toEqual(plain);
    expect(await compileAndSolve(ents, heldRules, undefined, { probe: { entity: "h", axis: "size" } })).toEqual(plain);
  });

  it("probe ids never reach the user's diagnostics", async () => {
    const r = await compileAndSolve(heldLine, heldRules, undefined, { probe: { entity: "o", axis: "y" } });
    expect({ dof: r.dof, conflicts: r.conflicts, overDefined: r.overDefined }).toEqual({
      dof: 2,
      conflicts: [],
      overDefined: ["o~probe0"],
    });
    expect(constraintIndexOf("o~probe0")).toBeNull();
  });
});
