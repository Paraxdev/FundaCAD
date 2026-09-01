import { describe, it, expect } from "vitest";
import {
  constraintFace, dofSummary, entityLabel, impliedJoins, relationRows,
} from "../../src/sketch/relations";
import { constraintGlyphs } from "../../src/sketch/glyphs";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

// The thread profile from the bug report: three lines meeting at three corners,
// and not one constraint recorded anywhere in the file.
const TRIANGLE = [
  line("e1", 20, 0, 26, 2),
  line("e2", 26, 2, 20, 5),
  line("e3", 20, 5, 20, 0),
];

const NONE = new Set<number>();

describe("entityLabel", () => {
  it("names an entity by kind and position among its own kind", () => {
    const ents = [line("a", 0, 0, 1, 0), { type: "circle", id: "c", radius: 2, x: 0, y: 0 } as ResolvedEntity, line("b", 0, 1, 1, 1)];
    expect(entityLabel(ents, "a")).toBe("Line 1");
    expect(entityLabel(ents, "b")).toBe("Line 2"); // the circle in between does not count
    expect(entityLabel(ents, "c")).toBe("Circle 1");
  });

  it("decodes the compound rectangle-edge operand", () => {
    const ents: ResolvedEntity[] = [{ type: "rectangle", id: "r", width: 4, height: 2, x: 0, y: 0 }];
    expect(entityLabel(ents, "r~2")).toBe("Rectangle 1 edge 3");
  });

  it("returns null for an id nothing answers to", () => {
    expect(entityLabel(TRIANGLE, "gone")).toBeNull();
  });
});

describe("constraintFace matches the canvas glyphs", () => {
  // The panel and the badge on the drawing are two views of one thing. If they
  // pick different characters for the same constraint the user has to learn the
  // set twice, and there is nothing to stop them drifting except this.
  it("uses the same symbol the glyph layer draws, for every glyphed constraint", () => {
    const ents = [
      line("l1", 0, 0, 10, 0),
      line("l2", 0, 5, 10, 5),
      { type: "circle", id: "c1", radius: 3, x: 0, y: 20 } as ResolvedEntity,
      { type: "circle", id: "c2", radius: 4, x: 0, y: 20 } as ResolvedEntity,
    ];
    const cs: SketchConstraint[] = [
      { type: "horizontal", line: "l1" },
      { type: "vertical", line: "l2" },
      { type: "parallel", l1: "l1", l2: "l2" },
      { type: "perpendicular", l1: "l1", l2: "l2" },
      { type: "collinear", l1: "l1", l2: "l2" },
      { type: "equal", l1: "l1", l2: "l2" },
      { type: "equalRadius", a: "c1", b: "c2" },
      { type: "tangent", line: "l1", circle: "c1" },
      { type: "tangent2", a: "c1", b: "c2" },
      { type: "coincident", e1: "l1", p1: 1, e2: "l2", p2: 0 },
      { type: "concentric", c1: "c1", c2: "c2" },
      { type: "midpoint", e: "l1", p: 0, line: "l2" },
      { type: "symmetric", e1: "l1", p1: 0, e2: "l2", p2: 0, line: "l1" },
      { type: "fix", e: "l1", p: 0 },
    ];
    const glyphs = constraintGlyphs(ents, cs);
    expect(glyphs.length).toBe(cs.length); // every one of them is glyphed
    for (const g of glyphs) {
      expect(constraintFace(cs[g.cIndex]!).symbol).toBe(g.label);
    }
  });

  it("gives the dimensional constraints a face too, though they have no glyph", () => {
    const cs: SketchConstraint[] = [
      { type: "distance", line: "l1", value: 10 },
      { type: "angle", l1: "l1", l2: "l2", value: 90 },
    ];
    expect(constraintGlyphs([], cs)).toEqual([]); // they render as dimension badges
    expect(constraintFace(cs[0]!).name).toBe("Length");
    expect(constraintFace(cs[1]!).name).toBe("Angle");
  });
});

describe("impliedJoins", () => {
  it("finds the corners of a closed chain that nothing recorded", () => {
    const joins = impliedJoins(TRIANGLE);
    expect(joins).toHaveLength(3);
    expect(joins.every((j) => j.implied)).toBe(true);
    expect(joins.every((j) => j.index === null)).toBe(true); // nothing to delete
    expect(joins[0]!.detail).toBe("Line 1 and Line 3"); // the corner at (20, 0)
  });

  // THE CONTROL. Pull one corner past the solver's 0.001mm merge bucket and the
  // join is gone — which is the point of using the solver's own key rather than
  // a tolerance of this file's own choosing.
  it("does not claim a join the solver would not make", () => {
    const apart = [
      line("e1", 20, 0, 26, 2),
      line("e2", 26.01, 2, 20, 5),
      line("e3", 20, 5, 20, 0),
    ];
    expect(impliedJoins(apart)).toHaveLength(2);
  });

  it("ignores construction geometry and lone endpoints", () => {
    expect(impliedJoins([line("a", 0, 0, 10, 0)])).toEqual([]);
    const c = [line("a", 0, 0, 10, 0), { ...line("b", 10, 0, 10, 9), construction: true }];
    expect(impliedJoins(c)).toEqual([]);
  });
});

describe("relationRows", () => {
  it("puts the drawn constraints first and the implied ones after", () => {
    const rows = relationRows(TRIANGLE, [{ type: "vertical", line: "e3" }], NONE, NONE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ index: 0, symbol: "V", name: "Vertical", detail: "Line 3" });
    expect(rows.slice(1).every((r) => r.implied)).toBe(true);
  });

  it("carries the solver's diagnosis onto the row that earned it", () => {
    const cs: SketchConstraint[] = [
      { type: "horizontal", line: "e1" },
      { type: "vertical", line: "e3" },
    ];
    const rows = relationRows(TRIANGLE, cs, new Set([0]), new Set([1]));
    expect(rows[0]!.state).toBe("conflict");
    expect(rows[1]!.state).toBe("over");
  });

  it("shows a dimension's value, and brackets a reference one", () => {
    const cs: SketchConstraint[] = [
      { type: "distance", line: "e1", value: 6.32 },
      { type: "angle", l1: "e1", l2: "e2", value: 90, driven: true },
    ];
    const rows = relationRows(TRIANGLE, cs, NONE, NONE);
    expect(rows[0]!.value).toBe("6.32 mm");
    expect(rows[1]!.value).toBe("(90°)"); // driven: measured, not driving
    expect(rows[1]!.driven).toBe(true);
  });

  it("survives a constraint pointing at geometry that is gone", () => {
    const rows = relationRows(TRIANGLE, [{ type: "horizontal", line: "deleted" }], NONE, NONE);
    expect(rows[0]!.detail).toBe("");
    expect(rows[0]!.name).toBe("Horizontal");
  });
});

describe("dofSummary", () => {
  it("does not call an unsolved sketch fully defined", () => {
    // dof < 0 is "no solve has run", which is where a sketch with no
    // constraints stays. Reporting it as 0 would be exactly backwards.
    expect(dofSummary(-1, false)).toBe("Not constrained");
    expect(dofSummary(0, false)).toBe("Fully defined");
  });

  it("counts, and gets the singular right", () => {
    expect(dofSummary(1, false)).toBe("1 degree of freedom");
    expect(dofSummary(6, false)).toBe("6 degrees of freedom");
  });

  it("says so when the sketch cannot be solved at all", () => {
    expect(dofSummary(3, true)).toBe("Conflicting constraints");
    expect(dofSummary(0, true)).toBe("Conflicting constraints"); // conflict beats a zero count
  });
});
