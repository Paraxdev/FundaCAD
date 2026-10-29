import { describe, expect, it } from "vitest";
import { itemsMove, itemsTreeMeta, sectionName, type ItemsNode } from "../../src/ui/itemsTree";
import { treeSlots } from "../../src/components/ui/treeContext";

describe("itemsTreeMeta", () => {
  it("gives each drawn row a level from its depth and a plugin section a top row named by the section", () => {
    const meta = itemsTreeMeta([
      { kind: "folder", k: "f:Sketches", depth: 0, collapsed: false, label: "Sketches" },
      { kind: "row", k: "s:s1", depth: 1, label: "Sketch1" },
      { kind: "plugin", k: "x:p:parameters", label: "Parameters" },
      { kind: "folder", k: "f:Bodies", depth: 0, collapsed: false, label: "Bodies" },
      { kind: "folder", k: "e1", depth: 1, collapsed: true, label: "Frame" },
      { kind: "row", k: "b:b1", depth: 1, label: "Body 1" },
    ]);
    expect(meta).toEqual([
      { key: "f:Sketches", level: 1, expandable: true, expanded: true, label: "Sketches" },
      { key: "s:s1", level: 2, label: "Sketch1" },
      { key: "x:p:parameters", level: 1, label: "Parameters" },
      { key: "f:Bodies", level: 1, expandable: true, expanded: true, label: "Bodies" },
      { key: "e1", level: 2, expandable: true, expanded: false, label: "Frame" },
      { key: "b:b1", level: 2, label: "Body 1" },
    ]);
    const s = treeSlots(meta);
    expect([s.get("b:b1")?.posinset, s.get("b:b1")?.setsize, s.get("f:Bodies")?.posinset]).toEqual([2, 2, 3]);
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

describe("itemsMove", () => {
  const nodes: ItemsNode[] = [
    { kind: "folder", k: "f:Origin", depth: 0, collapsed: false, label: "Origin" },
    { kind: "row", k: "o:XY", depth: 1, label: "XY plane" },
    { kind: "folder", k: "f:Bodies", depth: 0, collapsed: false, label: "Bodies" },
    { kind: "folder", k: "e1", depth: 1, collapsed: false, label: "Frame" },
    { kind: "row", k: "b:b1", depth: 2, label: "Body 1" },
    { kind: "row", k: "b:b2", depth: 1, label: "Body 2" },
    { kind: "folder", k: "f:Sketches", depth: 0, collapsed: false, label: "Sketches" },
    { kind: "row", k: "s:s1", depth: 1, label: "Sketch1" },
    { kind: "row", k: "s:s2", depth: 1, label: "Sketch2" },
    { kind: "plugin", k: "x:p:refs", label: "Refs" },
    { kind: "folder", k: "f:Planes", depth: 0, collapsed: false, label: "Planes" },
    { kind: "row", k: "p:d1", depth: 1, label: "Plane1" },
  ];

  it("takes a feature row past its neighbour under the same head", () => {
    expect(itemsMove(nodes, "s:s2", -1)).toEqual({ kind: "past", id: "s2", sibling: "s1", label: "Sketch1" });
    expect(itemsMove(nodes, "s:s1", 1)).toEqual({ kind: "past", id: "s1", sibling: "s2", label: "Sketch2" });
  });

  it("stops at the ends of its section, whatever sits beyond the head", () => {
    expect(itemsMove(nodes, "s:s1", -1)).toEqual({ kind: "end" });
    expect(itemsMove(nodes, "s:s2", 1)).toEqual({ kind: "end" });
    expect(itemsMove(nodes, "p:d1", -1)).toEqual({ kind: "end" });
  });

  it("leaves rows that are not timeline features, and every head, where they are", () => {
    expect(
      ["o:XY", "b:b1", "b:b2", "f:Sketches", "e1", "x:p:refs", "nope"].map((k) => itemsMove(nodes, k, -1)),
    ).toEqual(Array(7).fill({ kind: "fixed" }));
  });
});
