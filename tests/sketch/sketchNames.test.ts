import { describe, expect, it } from "vitest";
import { distinctNames, relationName, stateWord } from "../../src/sketch/sketchNames";

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
