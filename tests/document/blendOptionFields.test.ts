import { describe, expect, it } from "vitest";
import { choiceFieldsFor, fieldApplies, fieldLabel, toggleFieldsFor } from "../../src/document/optionFields";

describe("fillet and chamfer option rows", () => {
  it("offers size type, continuity and tangent edges on a fillet", () => {
    expect(choiceFieldsFor("fillet").map((c) => c.field)).toEqual(["sizeType", "continuity"]);
    expect(toggleFieldsFor("fillet").map((t) => t.field)).toEqual(["tangentEdges"]);
  });

  it("shows the second chamfer distance only for a two-distance chamfer", () => {
    expect(fieldApplies("chamfer", "distance2", {})).toBe(false);
    expect(fieldApplies("chamfer", "distance2", { chamferType: "twoDistance" })).toBe(true);
  });

  it("hides the conic profile on a G2 fillet, which ignores it", () => {
    expect(fieldApplies("fillet", "profile", { continuity: "G1" })).toBe(true);
    expect(fieldApplies("fillet", "profile", { continuity: "G2" })).toBe(false);
  });

  it("calls the size a chord length when that is what it is", () => {
    expect(fieldLabel("fillet", "radius", {})).toBeNull();
    expect(fieldLabel("fillet", "radius", { sizeType: "chord" })?.text).toBe("Chord Length");
  });
});
