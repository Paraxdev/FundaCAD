// The freedom summary is only spoken once a plain solve has settled, a dimension solve does not count.

import { describe, expect, it, vi } from "vitest";
import { SketchMode } from "../../src/sketch/sketchMode";
import type { SketchConstraint } from "../../src/types";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

const solved = { conflicts: [], overDefined: [], entities: [], dof: 4 };
const compileAndSolve = vi.fn(async () => solved);
const solveKeepingAxes = vi.fn(async () => solved);
vi.mock("../../src/sketch/sketchSolve", async (orig) => ({
  ...(await orig<typeof import("../../src/sketch/sketchSolve")>()),
  compileAndSolve: () => compileAndSolve(),
  solveKeepingAxes: () => solveKeepingAxes(),
}));

type Fake = Record<string, unknown> & { pump(): Promise<void>; dofKnown(): boolean };

function mode(constraints: SketchConstraint[], dimSolve: unknown = null) {
  const readies: boolean[] = [];
  const s = Object.create(SketchMode.prototype) as Fake;
  Object.assign(s, {
    active: true,
    solveBusy: false,
    solverDead: false,
    pendingDrag: null,
    solveDirty: true,
    entityVersion: 1,
    entities: [],
    constraints,
    dimSolve,
    armPreEdit() {},
    firstSolveSettled: false,
    lastDof: -1,
    conflict: false,
    refreshActive() {
      readies.push(s.dofKnown());
    },
  });
  return { s, readies };
}

const one: SketchConstraint[] = [{ type: "horizontal", line: "l1" }];

describe("sketch freedom readiness", () => {
  it("is ready at once for a sketch with no constraints", () => {
    expect(mode([]).s.dofKnown()).toBe(true);
  });

  it("is not ready with constraints until a plain solve lands, then is", async () => {
    const { s, readies } = mode(one);
    expect(s.dofKnown()).toBe(false);
    await s.pump();
    expect(readies).toEqual([true]);
  });

  it("does not count a dimension solve as the first settled one", async () => {
    const { s, readies } = mode(one, { anchor: { x: 5, y: 7 } });
    await s.pump();
    expect(solveKeepingAxes).toHaveBeenCalledTimes(1);
    expect(readies).toEqual([false]);
  });
});
