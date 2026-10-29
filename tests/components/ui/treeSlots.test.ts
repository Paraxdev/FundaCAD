import { describe, expect, it } from "vitest";

import { isMenuKeyEvent, treeSlots, typeAheadIndex, type TreeMeta } from "../../../src/components/ui/treeContext";

const items: TreeMeta[] = [
  { key: "a", level: 1, expandable: true, expanded: true, label: "Bodies" },
  { key: "a1", level: 2, label: "Body 1" },
  { key: "a2", level: 2, label: "Body 2" },
  { key: "b", level: 1, expandable: true, label: "Sketches" },
  { key: "c", level: 1, label: "Base", disabled: true },
  { key: "d", level: 1, label: "Bolt" },
];

describe("treeSlots", () => {
  it("numbers each row among its siblings, a child among its parent's children", () => {
    const s = treeSlots(items);
    expect(
      ["a", "a1", "a2", "b", "c", "d"].map((k) => [s.get(k)!.level, s.get(k)!.posinset, s.get(k)!.setsize]),
    ).toEqual([
      [1, 1, 4],
      [2, 1, 2],
      [2, 2, 2],
      [1, 2, 4],
      [1, 3, 4],
      [1, 4, 4],
    ]);
  });

  it("is expanded only when it can expand", () => {
    const s = treeSlots([{ key: "x", level: 1, expanded: true }]);
    expect(s.get("x")).toMatchObject({ expandable: false, expanded: false });
    expect(treeSlots(items).get("b")).toMatchObject({ expandable: true, expanded: false });
  });
});

describe("typeAheadIndex", () => {
  it("finds the next row after the current one that starts with the text", () => {
    expect(typeAheadIndex(items, 0, "b")).toBe(1);
    expect(typeAheadIndex(items, 1, "b")).toBe(2);
    expect(typeAheadIndex(items, 2, "b")).toBe(5);
    expect(typeAheadIndex(items, 5, "b")).toBe(0);
  });

  it("keeps the current row while a longer text still matches it, and skips disabled rows", () => {
    expect(typeAheadIndex(items, 1, "body 2")).toBe(2);
    expect(typeAheadIndex(items, 1, "bo")).toBe(1);
    expect(typeAheadIndex(items, 3, "ba")).toBe(-1);
  });

  it("steps through the rows on one letter typed again", () => {
    expect(typeAheadIndex(items, 1, "bb")).toBe(2);
  });
});

describe("isMenuKeyEvent", () => {
  const key = (k: string, init: KeyboardEventInit = {}) => ({ key: k, ...init }) as unknown as KeyboardEvent;
  it("is Shift+F10 or the Menu key, nothing with Ctrl, Alt or Meta", () => {
    expect(isMenuKeyEvent(key("F10", { shiftKey: true }))).toBe(true);
    expect(isMenuKeyEvent(key("ContextMenu"))).toBe(true);
    expect(isMenuKeyEvent(key("F10"))).toBe(false);
    expect(isMenuKeyEvent(key("F10", { shiftKey: true, ctrlKey: true }))).toBe(false);
  });
});
