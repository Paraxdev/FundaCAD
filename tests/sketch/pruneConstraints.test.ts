// pruneConstraints drops relations whose operands are gone. A point relation
// may sit on any point a menu or a snap can name: a circle centre, a rectangle
// corner, or a rectangle side as the curve.
import { describe, it, expect } from "vitest";
import { SketchMode } from "../../src/sketch/sketchMode";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const prune = (entities: ResolvedEntity[], constraints: SketchConstraint[]) => {
  const self = { entities, constraints };
  (SketchMode.prototype as unknown as { pruneConstraints(this: typeof self): void }).pruneConstraints.call(self);
  return self.constraints;
};

const ENTS: ResolvedEntity[] = [
  { type: "circle", id: "K", x: 0, y: 0, radius: 5 },
  { type: "point", id: "P", x: 20, y: 0 },
  { type: "rectangle", id: "Q", x: 30, y: 0, width: 10, height: 10 },
  { type: "line", id: "A", x1: 0, y1: 0, x2: 40, y2: 0 },
];

describe("pruneConstraints", () => {
  it("keeps point relations on circle centres, rectangle corners and rectangle sides", () => {
    const cs: SketchConstraint[] = [
      { type: "coincident", e1: "K", p1: 0, e2: "P", p2: 0 },
      { type: "coincident", e1: "Q", p1: 0, e2: "A", p2: 1 },
      { type: "midpoint", e: "K", p: 0, line: "A" },
      { type: "coincident", e1: "A", p1: 1, e2: "P", p2: 0 },
      { type: "parallel", l1: "A", l2: "Q~0" },
      { type: "pointOnCurve", e: "P", p: 0, curve: "Q~1" },
      { type: "symmetric", e1: "K", p1: 0, e2: "Q", p2: 2, line: "A" },
      { type: "horizontalPoints", e1: "K", p1: 0, e2: "Q", p2: 3 },
      { type: "verticalPoints", e1: "P", p1: 0, e2: "A", p2: 0 },
      { type: "tangent2", a: "Q~2", b: "K" },
    ];
    expect(prune(ENTS, [...cs])).toEqual(cs);
  });

  it("still drops them once an operand is gone", () => {
    const cs: SketchConstraint[] = [
      { type: "horizontalPoints", e1: "K", p1: 0, e2: "gone", p2: 0 },
      { type: "pointOnCurve", e: "P", p: 0, curve: "Q~9" },
      { type: "tangent2", a: "gone~0", b: "K" },
    ];
    expect(prune(ENTS, cs)).toEqual([]);
  });
});
