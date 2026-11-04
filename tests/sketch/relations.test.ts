import { describe, it, expect } from "vitest";
import { constraintFace, dofSummary, entityLabel, impliedJoins, relationRows } from "../../src/sketch/relations";
import { constraintGlyphs } from "../../src/sketch/glyphs";
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

// The thread profile from the bug report: three lines meeting at three corners,
// and not one constraint recorded anywhere in the file.
const TRIANGLE = [line("e1", 20, 0, 26, 2), line("e2", 26, 2, 20, 5), line("e3", 20, 5, 20, 0)];

const NONE = new Set<number>();

describe("entityLabel", () => {
  it("names an entity by kind and position among its own kind", () => {
    const ents = [
      line("a", 0, 0, 1, 0),
      { type: "circle", id: "c", radius: 2, x: 0, y: 0 } as ResolvedEntity,
      line("b", 0, 1, 1, 1),
    ];
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
  // pick different icons for the same constraint the user has to learn the
  // set twice, and there is nothing to stop them drifting except this.
  it("uses the same icon the glyph layer draws, for every glyphed constraint", () => {
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
      expect(constraintFace(cs[g.cIndex]!).icon).toBe(g.icon);
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
  // join is gone, which is the point of using the solver's own key rather than
  // a tolerance of this file's own choosing.
  it("does not claim a join the solver would not make", () => {
    const apart = [line("e1", 20, 0, 26, 2), line("e2", 26.01, 2, 20, 5), line("e3", 20, 5, 20, 0)];
    expect(impliedJoins(apart)).toHaveLength(2);
  });

  it("leaves out a corner a recorded coincident already lists", () => {
    const [a, b] = [TRIANGLE[0]!.id, TRIANGLE[1]!.id];
    const joins = impliedJoins(TRIANGLE, [{ type: "coincident", e1: b, p1: 0, e2: a, p2: 1 }]);
    expect(joins).toHaveLength(2);
    expect(joins.some((j) => j.entities.includes(a) && j.entities.includes(b))).toBe(false);
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
    expect(rows[0]).toMatchObject({ index: 0, icon: "vertical", name: "Vertical", detail: "Line 3" });
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

  it("names a rectangle side Width or Height and a distance on one shape by that shape once", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", width: 40, height: 15, x: 7, y: -3, angle: 20 },
      line("l", 3, 4, 28, 11),
      { type: "rectangle", id: "q", width: 22, height: 9, x: -11, y: 6 },
    ];
    const cs: SketchConstraint[] = [
      { type: "p2pDistance", e1: "r", p1: 0, e2: "r", p2: 1, value: 40 },
      { type: "p2pDistance", e1: "r", p1: 3, e2: "r", p2: 0, value: 15, driven: true },
      { type: "p2pDistance", e1: "q", p1: 2, e2: "q", p2: 3, value: 22 },
      { type: "p2pDistance", e1: "q", p1: 0, e2: "q", p2: 2, value: 23.8 },
      { type: "hDistance", e1: "l", p1: 0, e2: "l", p2: 1, value: 25 },
      { type: "p2pDistance", e1: "l", p1: 0, e2: "r", p2: 2, value: 9 },
    ];
    expect(relationRows(ents, cs, NONE, NONE).map((r) => [r.name, r.detail, r.spoken])).toEqual([
      ["Width", "Rectangle 1", "Width 40 mm, Rectangle 1"],
      ["Height", "Rectangle 1", "Height 15 mm, Rectangle 1, reference"],
      ["Width", "Rectangle 2", "Width 22 mm, Rectangle 2"],
      ["Distance", "Rectangle 2", "Distance 23.8 mm, Rectangle 2"],
      ["Horizontal distance", "Line 1", "Horizontal distance 25 mm, Line 1"],
      ["Distance", "Line 1 and Rectangle 1", "Distance 9 mm, Line 1 and Rectangle 1"],
    ]);
  });

  it("names the point a Fix holds, so it does not read as the whole shape", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", width: 40, height: 15, x: 7, y: -3 },
      line("l", 3, 4, 28, 11),
      { type: "arc", id: "a", x1: 30, y1: 0, x2: 20, y2: 10, mx: 22.9, my: 2.9 },
      { type: "circle", id: "c", x: -12, y: 5, radius: 3.5 },
      { type: "point", id: "p", x: 1.5, y: -8 },
    ];
    const cs: SketchConstraint[] = [
      { type: "fix", e: "r", p: 2 },
      { type: "fix", e: "l", p: 0 },
      { type: "fix", e: "l", p: 1 },
      { type: "fix", e: "a", p: 2 },
      { type: "fix", e: "a", p: 1 },
      { type: "fix", e: "c", p: 0 },
      { type: "fix", e: "p", p: 0 },
    ];
    expect(relationRows(ents, cs, NONE, NONE).map((r) => r.spoken)).toEqual([
      "Fixed corner, Rectangle 1",
      "Fixed start, Line 1",
      "Fixed end, Line 1",
      "Fixed centre, Arc 1",
      "Fixed end, Arc 1",
      "Fixed centre, Circle 1",
      "Fixed, Point 1",
    ]);
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
    expect(dofSummary(0, true)).toBe("Conflicting constraints"); // conflict is preferred over a zero count
  });
});

describe("relation row words", () => {
  const spoken = (cs: SketchConstraint[], conflicts = NONE, over = NONE) =>
    relationRows(TRIANGLE, cs, conflicts, over).map((r) => [r.key, r.spoken, r.stateWord]);

  it("keys a constraint by index and an implied join by its shapes", () => {
    const rows = relationRows(TRIANGLE, [{ type: "vertical", line: "e3" }], NONE, NONE);
    expect(rows.map((r) => r.key)).toEqual(["0", "implied:e1,e3", "implied:e1,e2", "implied:e2,e3"]);
  });

  it("reads each state out loud", () => {
    const cs: SketchConstraint[] = [
      { type: "horizontal", line: "e1" },
      { type: "vertical", line: "e3" },
      { type: "distance", line: "e1", value: 6.32 },
      { type: "angle", l1: "e1", l2: "e2", value: 90, driven: true },
    ];
    const rows = relationRows(TRIANGLE, cs, new Set([0]), new Set([1]));
    expect(rows.slice(0, 4).map((r) => [r.spoken, r.stateWord])).toEqual([
      ["Horizontal, Line 1, conflicting", "conflicting"],
      ["Vertical, Line 3, redundant", "redundant"],
      ["Length 6.32 mm, Line 1", undefined],
      ["Angle 90°, Line 1 and Line 2, reference", "reference"],
    ]);
    expect(rows.slice(4).map((r) => [r.spoken, r.stateWord])).toEqual([
      ["Coincident, Line 1 and Line 3, implied", "implied"],
      ["Coincident, Line 1 and Line 2, implied", "implied"],
      ["Coincident, Line 2 and Line 3, implied", "implied"],
    ]);
  });

  it("numbers a repeated name by its row and only that name", () => {
    const rows = spoken([
      { type: "horizontal", line: "e1" },
      { type: "horizontal", line: "e1" },
      { type: "vertical", line: "e3" },
    ]);
    expect(rows.slice(0, 3)).toEqual([
      ["0", "Horizontal, Line 1, row 1", undefined],
      ["1", "Horizontal, Line 1, row 2", undefined],
      ["2", "Vertical, Line 3", undefined],
    ]);
  });

  it("gives none, one and many rows a unique name each", () => {
    expect(spoken([])).toHaveLength(3);
    expect(spoken([{ type: "vertical", line: "e3" }])[0]).toEqual(["0", "Vertical, Line 3", undefined]);
    const many = relationRows(
      TRIANGLE,
      [1, 2, 3, 4].map(() => ({ type: "vertical", line: "e3" }) as SketchConstraint),
      NONE,
      NONE,
    ).map((r) => r.spoken);
    expect(new Set(many).size).toBe(many.length);
  });
});
