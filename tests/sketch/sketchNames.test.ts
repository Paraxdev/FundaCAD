import { describe, expect, it } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import {
  constraintDimName,
  dimKey,
  distinctNames,
  entityDimName,
  entityLabel,
  entityLabeller,
  relationName,
  shapeRow,
  stateWord,
} from "../../src/sketch/sketchNames";

describe("stateWord", () => {
  it("says each state in one word, an implied row first", () => {
    expect(stateWord({ state: null })).toBeUndefined();
    expect(stateWord({ state: "conflict" })).toBe("conflicting");
    expect(stateWord({ state: "over" })).toBe("redundant");
    expect(stateWord({ state: null, driven: true })).toBe("reference");
    expect(stateWord({ state: null, implied: true })).toBe("implied");
    expect(stateWord({ state: "conflict", implied: true })).toBe("implied");
    expect(stateWord({ state: "over", driven: true })).toBe("redundant");
  });
});

describe("relationName", () => {
  it("joins name and value, then the shapes, then the state", () => {
    expect(relationName({ name: "Distance", value: "12.5 mm", detail: "Line 1 and Line 3", state: "conflict" })).toBe(
      "Distance 12.5 mm, Line 1 and Line 3, conflicting",
    );
  });

  it("leaves out what a row does not have", () => {
    expect(relationName({ name: "Horizontal", detail: "Line 2", state: null })).toBe("Horizontal, Line 2");
    expect(relationName({ name: "Horizontal", detail: "", state: null })).toBe("Horizontal");
    expect(
      relationName({ name: "Angle", value: "(37.5°)", detail: "Line 1 and Line 2", state: null, driven: true }),
    ).toBe("Angle 37.5°, Line 1 and Line 2, reference");
  });
});

describe("distinctNames", () => {
  it("numbers only the names that repeat, by place in the list", () => {
    expect(distinctNames(["a", "b", "a", "c", "a", "b"])).toEqual([
      "a, row 1",
      "b, row 2",
      "a, row 3",
      "c",
      "a, row 5",
      "b, row 6",
    ]);
  });

  it("leaves none, one and distinct names alone", () => {
    expect(distinctNames([])).toEqual([]);
    expect(distinctNames(["a"])).toEqual(["a"]);
    expect(distinctNames(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("entityDimName", () => {
  it("names the measure and the shape, or the measure alone", () => {
    expect(entityDimName("Width", "Rectangle 2")).toBe("Width of Rectangle 2");
    expect(entityDimName("Width", null)).toBe("Width");
  });
});

describe("constraintDimName", () => {
  it("reads one, two and three distinct operands", () => {
    expect(constraintDimName("Radius", ["Arc 1"])).toBe("Radius of Arc 1");
    expect(constraintDimName("Distance", ["Line 1", "Line 3"])).toBe("Distance between Line 1 and Line 3");
    expect(constraintDimName("Rim to rim", ["Circle 1", "Circle 2", "Arc 4"])).toBe(
      "Rim to rim between Circle 1, Circle 2 and Arc 4",
    );
  });

  it("counts an operand once, and has a bare name for none", () => {
    expect(constraintDimName("Distance", ["Line 2", "Line 2"])).toBe("Distance of Line 2");
    expect(constraintDimName("Dimension", [])).toBe("Dimension");
  });
});

describe("dimKey", () => {
  it("is the stood in subject, else the constraint id, else its place", () => {
    expect(dimKey("r1:width", "k9", 4)).toBe("r1:width");
    expect(dimKey(null, "k9", 4)).toBe("c:k9");
    expect(dimKey(null, undefined, 4)).toBe("c:#4");
  });
});

describe("entityLabeller", () => {
  const ents: ResolvedEntity[] = [
    { type: "rectangle", id: "r1", x: 7.5, y: -3, width: 40, height: 15, angle: 20 },
    { type: "line", id: "l1", x1: 3.5, y1: -2, x2: 11, y2: 7.25 },
    { type: "circle", id: "c1", x: 41, y: -7, radius: 3.5 },
    { type: "line", id: "l2", x1: 11, y1: 7.25, x2: 14.5, y2: 1 },
    { type: "rectangle", id: "r2", x: -9, y: 12, width: 6, height: 4.5 },
    { type: "line", id: "l3", x1: 14.5, y1: 1, x2: 3.5, y2: -2 },
  ];
  const ids = ["r1", "l1", "c1", "l2", "r2", "l3", "r2~3", "r1~0", "r1~x", "gone", "gone~1"];

  it("names every id the way entityLabel does, edges and unknown ids too", () => {
    const label = entityLabeller(ents);
    expect(ids.map(label)).toEqual([
      "Rectangle 1",
      "Line 1",
      "Circle 1",
      "Line 2",
      "Rectangle 2",
      "Line 3",
      "Rectangle 2 edge 4",
      "Rectangle 1 edge 1",
      "Rectangle 1",
      null,
      null,
    ]);
    expect(ids.map(label)).toEqual(ids.map((id) => entityLabel(ents, id)));
  });

  it("knows nothing in an empty list, one shape in a list of one, and reads a second list afresh", () => {
    expect(entityLabeller([])("l1")).toBeNull();
    expect(entityLabeller(ents.slice(3, 4))("l2")).toBe("Line 1");
    expect(entityLabeller(ents)("l2")).toBe("Line 2");
  });
});

describe("shapeRow", () => {
  const ents: ResolvedEntity[] = [
    { type: "line", id: "a", x1: 3.5, y1: -2, x2: 11, y2: 7.25 },
    { type: "circle", id: "b", x: 41, y: -7, radius: 3.5 },
    { type: "line", id: "c", x1: 11, y1: 7.25, x2: 14.5, y2: 1, construction: true },
    { type: "projected", id: "d", construction: true } as unknown as ResolvedEntity,
  ];
  const row = (i: number, f?: { x: boolean; y: boolean; size: boolean }) => shapeRow(entityLabeller(ents), ents[i]!, f);

  it("names the shape by its place among its kind, with the freedom after it", () => {
    expect(row(2, { x: true, y: false, size: false })).toEqual({
      id: "c",
      label: "Line 2",
      hint: "construction · free in X",
      spoken: "Line 2, construction, free in X",
    });
    expect(row(1, { x: true, y: true, size: true })).toEqual({
      id: "b",
      label: "Circle 1",
      hint: "free in X, Y and size",
      spoken: "Circle 1, free in X, Y and size",
    });
  });

  it("adds no word for unknown freedom, and says fixed for none", () => {
    expect(row(0)).toEqual({ id: "a", label: "Line 1", hint: "", spoken: "Line 1" });
    expect(row(0, { x: false, y: false, size: false })).toEqual({
      id: "a",
      label: "Line 1",
      hint: "fixed",
      spoken: "Line 1, fixed",
    });
  });

  it("does not call projected geometry construction", () => {
    expect(row(3, { x: false, y: false, size: false }).spoken).toBe("Reference 1, fixed");
  });

  it("falls back to the id for an entity the list does not hold", () => {
    expect(shapeRow(entityLabeller([]), ents[0]!, undefined)).toEqual({ id: "a", label: "a", hint: "", spoken: "a" });
  });
});
