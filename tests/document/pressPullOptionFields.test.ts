import { describe, expect, it } from "vitest";
import { fieldApplies, toggleFieldsFor, toggleValue } from "../../src/document/optionFields";
import type { Feature } from "../../src/types";

const pressPull = (extra: Record<string, unknown> = {}) =>
  ({ id: "f1", type: "press-pull", face: "face:0", distance: -0.5, operation: "cut", ...extra }) as unknown as Feature;

const offsetFace = (extra: Record<string, unknown> = {}) =>
  ({ id: "f2", type: "offsetFace", faces: ["face:0"], distance: 0.5, ...extra }) as unknown as Feature;

const shownRows = (f: Feature) => {
  const values = f as unknown as Record<string, unknown>;
  return toggleFieldsFor(f.type)
    .filter((t) => fieldApplies(f.type, t.field, values))
    .map((t) => ({ field: t.field, label: t.label, current: toggleValue(f, t) }));
};

describe("tangent faces follow option row", () => {
  it("offers the row on press-pull and offset face, true when absent", () => {
    for (const type of ["press-pull", "offsetFace"] as const) {
      const row = toggleFieldsFor(type).find((t) => t.field === "followTangent");
      expect(row).toEqual({ field: "followTangent", label: "Tangent faces follow", fallback: true });
    }
  });

  it("hides the row when the feature does not carry the field", () => {
    expect(shownRows(pressPull())).toEqual([]);
    expect(shownRows(offsetFace())).toEqual([]);
  });

  it("hides the row on a non-auto mode", () => {
    for (const mode of ["cut", "join", "new", "intersect"]) {
      expect(shownRows(pressPull({ followTangent: true, mode }))).toEqual([]);
    }
  });

  it("hides the row on an axis push", () => {
    expect(shownRows(pressPull({ followTangent: true, direction: "axis" }))).toEqual([]);
  });

  it("shows the stored value on an auto, along normal press-pull", () => {
    const row = { field: "followTangent", label: "Tangent faces follow" };
    expect(shownRows(pressPull({ followTangent: false }))).toEqual([{ ...row, current: false }]);
    expect(shownRows(pressPull({ followTangent: true, mode: "auto", direction: "normal" })))
      .toEqual([{ ...row, current: true }]);
  });

  it("shows the stored value on an offset face", () => {
    expect(shownRows(offsetFace({ followTangent: false })))
      .toEqual([{ field: "followTangent", label: "Tangent faces follow", current: false }]);
  });

  it("falls back to true for a value that is not a boolean", () => {
    const row = toggleFieldsFor("press-pull")[0]!;
    expect(toggleValue(pressPull({ followTangent: "yes" }), row)).toBe(true);
    expect(fieldApplies("press-pull", "followTangent", { followTangent: "yes" })).toBe(false);
  });

  it("leaves the other press-pull rows alone", () => {
    expect(fieldApplies("press-pull", "distance", { mode: "cut", direction: "axis" })).toBe(true);
    expect(fieldApplies("press-pull", "taper", {})).toBe(true);
  });
});
