// The pure half of elements: placing folders, refusing loops, and what a delete
// does to what the folder held.
//
// Worth testing directly rather than through the panel because every case here
// is one nobody types on purpose: a parent that was deleted by another window, a
// cycle in a hand-edited file, a folder dropped onto its own grandchild. The
// panel would show each of those as "some rows are missing".

import { describe, expect, it } from "vitest";
import {
  ancestryOf, childrenByParent, descendantsOf, type ElementDef, freshElementName,
  isCyclic, reparented, withElementRemoved, wouldCycle,
} from "../../src/document/elements";

/** Chassis > Frame > Bracket, plus a sibling. */
const TREE: ElementDef[] = [
  { id: "e1", name: "Chassis" },
  { id: "e2", name: "Frame", parent: "e1" },
  { id: "e3", name: "Bracket", parent: "e2" },
  { id: "e4", name: "Electronics" },
];

const ids = (list: readonly ElementDef[] | undefined) => (list ?? []).map((e) => e.id);

describe("childrenByParent", () => {
  it("places each element under its parent, roots under the empty key", () => {
    const kids = childrenByParent(TREE);
    expect(ids(kids.get(""))).toEqual(["e1", "e4"]);
    expect(ids(kids.get("e1"))).toEqual(["e2"]);
    expect(ids(kids.get("e2"))).toEqual(["e3"]);
  });

  it("lifts an element whose parent is gone to the top rather than dropping it", () => {
    const kids = childrenByParent([{ id: "e9", name: "Orphan", parent: "nope" }]);
    expect(ids(kids.get(""))).toEqual(["e9"]);
    // the control: with the parent present it is NOT at the top
    const ok = childrenByParent([{ id: "p", name: "P" }, { id: "e9", name: "Orphan", parent: "p" }]);
    expect(ids(ok.get(""))).toEqual(["p"]);
  });

  it("lifts a cycle's members to the top, and leaves what merely hangs off one alone", () => {
    // b -> a -> b is the loop; c sits under b and is not in it.
    const loop: ElementDef[] = [
      { id: "a", name: "A", parent: "b" },
      { id: "b", name: "B", parent: "a" },
      { id: "c", name: "C", parent: "b" },
    ];
    const kids = childrenByParent(loop);
    expect(ids(kids.get("")).sort()).toEqual(["a", "b"]);
    expect(ids(kids.get("b"))).toEqual(["c"]);
  });

  it("terminates on a self-parented element", () => {
    const kids = childrenByParent([{ id: "x", name: "X", parent: "x" }]);
    expect(ids(kids.get(""))).toEqual(["x"]);
  });
});

describe("ancestryOf", () => {
  it("walks nearest first and stops at the root", () => {
    expect(ancestryOf(TREE, "e3")).toEqual(["e3", "e2", "e1"]);
    expect(ancestryOf(TREE, "e1")).toEqual(["e1"]);
  });

  it("is empty for an id that is not there", () => {
    expect(ancestryOf(TREE, "nope")).toEqual([]);
  });

  it("stops at the first repeat instead of looping forever", () => {
    const loop: ElementDef[] = [
      { id: "a", name: "A", parent: "b" },
      { id: "b", name: "B", parent: "a" },
    ];
    expect(ancestryOf(loop, "a")).toEqual(["a", "b"]);
    expect(isCyclic(loop, "a")).toBe(true);
    expect(isCyclic(TREE, "e3")).toBe(false); // the control
  });
});

describe("descendantsOf / wouldCycle", () => {
  it("collects the element and everything below it", () => {
    expect([...descendantsOf(TREE, "e1")].sort()).toEqual(["e1", "e2", "e3"]);
    expect([...descendantsOf(TREE, "e3")]).toEqual(["e3"]);
  });

  it("refuses a move into the element's own subtree, and allows one out of it", () => {
    expect(wouldCycle(TREE, "e1", "e3")).toBe(true); // Chassis into its own grandchild
    expect(wouldCycle(TREE, "e1", "e1")).toBe(true); // and into itself
    expect(wouldCycle(TREE, "e1", "e4")).toBe(false); // the control: a sibling is fine
    expect(wouldCycle(TREE, "e3", null)).toBe(false); // the top level always is
  });
});

describe("reparented", () => {
  it("moves an element and drops the field at the top level", () => {
    expect(reparented(TREE, "e3", "e4").find((e) => e.id === "e3")).toEqual({
      id: "e3", name: "Bracket", parent: "e4",
    });
    // `parent` deleted, not set to undefined: the document omits what is empty.
    const top = reparented(TREE, "e3", null).find((e) => e.id === "e3")!;
    expect(top).toEqual({ id: "e3", name: "Bracket" });
    expect("parent" in top).toBe(false);
  });

  it("leaves the list alone when the move would loop", () => {
    const out = reparented(TREE, "e1", "e3");
    expect(out.find((e) => e.id === "e1")).toEqual({ id: "e1", name: "Chassis" });
    // the control: the same call to a legal target does move it
    expect(reparented(TREE, "e1", "e4").find((e) => e.id === "e1")!.parent).toBe("e4");
  });

  it("leaves the list alone when either end is not there", () => {
    expect(reparented(TREE, "nope", "e1")).toEqual(TREE);
    expect(reparented(TREE, "e1", "nope")).toEqual(TREE);
  });
});

describe("withElementRemoved", () => {
  it("lifts the children into the deleted element's own parent", () => {
    const { elements, movedTo } = withElementRemoved(TREE, "e2");
    expect(movedTo).toBe("e1");
    expect(ids(elements)).toEqual(["e1", "e3", "e4"]);
    expect(elements.find((e) => e.id === "e3")!.parent).toBe("e1");
  });

  it("lifts them to the TOP when the deleted element was already there", () => {
    const { elements, movedTo } = withElementRemoved(TREE, "e1");
    expect(movedTo).toBeNull();
    const frame = elements.find((e) => e.id === "e2")!;
    expect(frame).toEqual({ id: "e2", name: "Frame" });
    // and the grandchild keeps its own parent, only ONE level is lifted
    expect(elements.find((e) => e.id === "e3")!.parent).toBe("e2");
  });

  it("changes nothing for an id that is not there", () => {
    const { elements, movedTo } = withElementRemoved(TREE, "nope");
    expect(elements).toEqual(TREE);
    expect(movedTo).toBeNull();
  });
});

describe("freshElementName", () => {
  it("numbers only against SIBLINGS", () => {
    const list: ElementDef[] = [
      { id: "a", name: "Element" },
      { id: "b", name: "Element", parent: "a" },
    ];
    expect(freshElementName(list, null)).toBe("Element 2"); // `a` holds it
    expect(freshElementName(list, "a")).toBe("Element 2"); // `b` holds it
    // The control: under `b` there are no siblings at all, so the plain name is
    // free even though two elements elsewhere are already called it.
    expect(freshElementName(list, "b")).toBe("Element");
  });

  it("ignores case, so a lower-case twin does not read as a free name", () => {
    expect(freshElementName([{ id: "a", name: "element" }], null)).toBe("Element 2");
  });
});
