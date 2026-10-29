import { describe, expect, it } from "vitest";
import { itemsTreeMeta, sectionName } from "../../src/ui/itemsTree";
import { treeSlots } from "../../src/components/ui/treeContext";

describe("itemsTreeMeta", () => {
  it("gives each drawn row a level from its depth and leaves plugin sections out", () => {
    const meta = itemsTreeMeta([
      { kind: "folder", k: "f:Sketches", depth: 0, collapsed: false, label: "Sketches" },
      { kind: "row", k: "s:s1", depth: 1, label: "Sketch1" },
      { kind: "plugin", k: "x:p:parameters" },
      { kind: "folder", k: "f:Bodies", depth: 0, collapsed: false, label: "Bodies" },
      { kind: "folder", k: "e1", depth: 1, collapsed: true, label: "Frame" },
      { kind: "row", k: "b:b1", depth: 1, label: "Body 1" },
    ]);
    expect(meta).toEqual([
      { key: "f:Sketches", level: 1, expandable: true, expanded: true, label: "Sketches" },
      { key: "s:s1", level: 2, label: "Sketch1" },
      { key: "f:Bodies", level: 1, expandable: true, expanded: true, label: "Bodies" },
      { key: "e1", level: 2, expandable: true, expanded: false, label: "Frame" },
      { key: "b:b1", level: 2, label: "Body 1" },
    ]);
    const s = treeSlots(meta);
    expect([s.get("b:b1")?.posinset, s.get("b:b1")?.setsize, s.get("f:Bodies")?.posinset]).toEqual([2, 2, 2]);
  });

  it("puts an empty note under the head before it, as a row the arrows skip", () => {
    const meta = itemsTreeMeta([
      { kind: "folder", k: "f:Bodies", depth: 0, collapsed: false, label: "Bodies" },
      { kind: "empty", k: "f:Bodies:empty" },
    ]);
    expect(meta[1]).toEqual({ key: "f:Bodies:empty", level: 2, disabled: true });
  });
});

describe("sectionName", () => {
  it("reads a plugin section key as words", () => {
    expect(["referenceImages", "parameters", "palette", "my-section"].map(sectionName)).toEqual([
      "Reference images",
      "Parameters",
      "Palette",
      "My section",
    ]);
  });
});
