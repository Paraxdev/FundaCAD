import { describe, expect, it } from "vitest";
import { exportScopeFromSelection } from "../../src/io/exportSettings";
import { buildBodyTree } from "../../src/ui/browserTree";

const bodies = [
  { id: "body1", name: "Base" },
  { id: "body2", name: "Lid" },
  { id: "body3", name: "Hinge" },
  { id: "body4", name: "Pin" },
];
// Folder "Top" holds Lid and a nested "Hardware" with Hinge and Pin.
const elements = [
  { id: "e1", name: "Top" },
  { id: "e2", name: "Hardware", parent: "e1" },
];
const map = new Map([
  ["body2", "e1"],
  ["body3", "e2"],
  ["body4", "e2"],
]);
const { groups } = buildBodyTree(bodies, new Map(), elements, map);

describe("export starts from the selection", () => {
  it("is the whole document with nothing selected", () => {
    expect(exportScopeFromSelection([], bodies, groups, "box")).toEqual({ scope: "all", selected: [], base: "box" });
  });

  it("is that body, named after it, for one body", () => {
    expect(exportScopeFromSelection(["body2"], bodies, groups, "box")).toEqual({
      scope: "body2",
      selected: ["body2"],
      base: "Lid",
    });
  });

  it("is the selected bodies in build order, named after the document, for loose bodies", () => {
    expect(exportScopeFromSelection(["body3", "body1"], bodies, groups, "box")).toEqual({
      scope: "selected",
      selected: ["body1", "body3"],
      base: "box",
    });
  });

  it("is named after the folder whose bodies are selected, the nested one too", () => {
    expect(exportScopeFromSelection(["body4", "body2", "body3"], bodies, groups, "box").base).toBe("Top");
    expect(exportScopeFromSelection(["body3", "body4"], bodies, groups, "box")).toEqual({
      scope: "selected",
      selected: ["body3", "body4"],
      base: "Hardware",
    });
  });

  it("drops a selected id that no longer built", () => {
    expect(exportScopeFromSelection(["body9", "body1"], bodies, groups, "box").scope).toBe("body1");
    expect(exportScopeFromSelection(["body9"], bodies, groups, "box").scope).toBe("all");
  });
});
