import { describe, expect, it } from "vitest";
import { clickTakes } from "../../src/viewport/clickIntent";

const none = new Set<string>();

describe("clickTakes", () => {
  it("takes the body on a first click", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: [], drilledBodies: none })).toBe("body");
  });

  it("takes the face on a click on the body already selected", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("part");
  });

  it("moves to another body whole", () => {
    expect(clickTakes({ bodyId: "b", additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("body");
    expect(clickTakes({ bodyId: "b", additive: false, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("body");
  });

  it("keeps picking faces on a body it is already inside", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("part");
  });

  it("Ctrl adds bodies to bodies and faces to faces", () => {
    expect(clickTakes({ bodyId: "a", additive: true, selectedBodies: ["a", "b"], drilledBodies: none })).toBe("body");
    expect(clickTakes({ bodyId: "b", additive: true, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("part");
  });

  it("leaves empty space to the ordinary pick", () => {
    expect(clickTakes({ bodyId: null, additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("part");
  });
});
