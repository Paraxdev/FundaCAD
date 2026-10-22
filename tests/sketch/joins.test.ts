// A recorded snap join is dropped when a modify step pulls its ends apart, and
// kept when they move together. A Coincident the user applied is always kept.
import { describe, it, expect } from "vitest";
import { dropSeparatedJoins } from "../../src/sketch/joins";
import { filletCorner } from "../../src/sketch/modify";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
const CHAIN = [line("A", 0, 0, 40, 0), line("B", 40, 0, 40, 30), line("C", 40, 30, 0, 30)];
const JOINS: SketchConstraint[] = [
  { type: "coincident", e1: "B", p1: 0, e2: "A", p2: 1, snap: true },
  { type: "coincident", e1: "C", p1: 0, e2: "B", p2: 1, snap: true },
];

describe("dropSeparatedJoins", () => {
  it("a fillet on a recorded corner drops only that corner's join", () => {
    const after = filletCorner(CHAIN, 0, 1, 5)!;
    expect(after).toBeTruthy();
    expect(dropSeparatedJoins(CHAIN, after, [...JOINS, { type: "horizontal", line: "A" }])).toEqual([
      JOINS[1],
      { type: "horizontal", line: "A" },
    ]);
  });

  it("moving a whole chain keeps its joins, moving one line away drops both of its", () => {
    const shift = (e: ResolvedEntity): ResolvedEntity => (e.type === "line" ? { ...e, x1: e.x1 + 5, x2: e.x2 + 5 } : e);
    expect(dropSeparatedJoins(CHAIN, CHAIN.map(shift), JOINS)).toEqual(JOINS);
    expect(
      dropSeparatedJoins(
        CHAIN,
        CHAIN.map((e) => (e.id === "B" ? shift(e) : e)),
        JOINS,
      ),
    ).toEqual([]);
  });

  it("a join that was not yet satisfied is left to the solver", () => {
    const apart = [line("A", 0, 0, 40, 0), line("B", 41, 1, 40, 30)];
    const moved = [apart[0]!, line("B", 45, 1, 40, 30)];
    expect(dropSeparatedJoins(apart, moved, [JOINS[0]!])).toEqual([JOINS[0]]);
  });

  it("a Coincident the user applied survives being pulled apart, the solver rejoins it", () => {
    const applied: SketchConstraint[] = JOINS.map((c) =>
      c.type === "coincident" ? { type: "coincident", e1: c.e1, p1: c.p1, e2: c.e2, p2: c.p2 } : c,
    );
    const shift = (e: ResolvedEntity): ResolvedEntity => (e.type === "line" ? { ...e, x1: e.x1 + 5, x2: e.x2 + 5 } : e);
    expect(
      dropSeparatedJoins(
        CHAIN,
        CHAIN.map((e) => (e.id === "B" ? shift(e) : e)),
        applied,
      ),
    ).toEqual(applied);
  });
});
