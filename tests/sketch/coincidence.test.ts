// Is a drawn chain actually JOINED, with no constraint recorded for it?
//
// sketchSolve merges two endpoints into ONE solver point when their positions
// match to 0.001mm (coincKey), so a chain of lines drawn end to end is held
// together structurally rather than by a coincident constraint. That is easy to
// doubt from the outside — a saved sketch of a closed triangle has no
// `constraints` key at all, which reads as "nothing is holding this together" —
// and the answer decides whether auto-constrain owes the user a coincident on
// every corner it draws. It does not: adding one would be redundant with the
// merge, and redundant is what the over-defined diagnosis is for.
//
// Counted in DEGREES OF FREEDOM, which is the only measure that can tell the
// two apart. Run against the real planegcs wasm, like sketchSolve.test.ts.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import type { ResolvedEntity } from "../../src/sketch/snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

// The thread profile from the bug report, as the file on disk holds it: three
// lines, no constraints, corners meeting exactly.
const CLOSED = [
  line("e1", 20, 0, 26, 2),
  line("e2", 26, 2, 20, 5),
  line("e3", 20, 5, 20, 0),
];

describe("a drawn chain is joined by position, not by a constraint", () => {
  it("a closed triangle has three points' worth of freedom, not six", async () => {
    const r = await compileAndSolve(CLOSED, []);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(6); // 3 corners x 2, i.e. every corner is ONE point
  });

  // THE CONTROL. Pull one corner a hundredth of a millimetre apart — past the
  // 0.001mm bucket — and the same three lines are four points, because two of
  // them no longer merge. If the assertion above passed for any other reason
  // this one would report 6 as well.
  it("a chain whose corners miss carries the extra freedom", async () => {
    const apart = [
      line("e1", 20, 0, 26, 2),
      line("e2", 26.01, 2, 20, 5), // 0.01mm short of e1's end
      line("e3", 20, 5, 20, 0),
    ];
    const r = await compileAndSolve(apart, []);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(8); // 4 points now: the split corner counts twice
  });

  it("a coincident constraint on a corner that already merged is redundant", async () => {
    // What auto-constrain would be adding on every corner it drew. planegcs is
    // asked to hold together two ends that are already the same variable, so it
    // reports the constraint as over-defining rather than as useful work.
    const r = await compileAndSolve(CLOSED, [
      { type: "coincident", e1: "e1", p1: 1, e2: "e2", p2: 0 },
    ]);
    expect(r.dof).toBe(6); // it removes no freedom, because there was none to remove
    expect(r.overDefined.length).toBeGreaterThan(0);
  });
});
