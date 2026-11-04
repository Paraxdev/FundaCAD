import { describe, expect, it } from "vitest";
import {
  constraintDimName,
  dimKey,
  distinctNames,
  entityDimName,
  relationName,
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
