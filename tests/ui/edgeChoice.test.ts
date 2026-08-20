// What the ambiguous-edge menu calls each row.

import { describe, expect, it } from "vitest";
import { bodyRowLabel, distinguish, dominantOwner, edgeChoiceLabel } from "../../src/ui/edgeChoice";

describe("dominantOwner", () => {
  it("names the operation that made most of the body", () => {
    expect(dominantOwner(["f1", "f1", "f1", "f2"])).toBe("f1");
  });

  it("ignores faces with no recorded owner", () => {
    expect(dominantOwner([null, "f2", null, "f2", "f1"])).toBe("f2");
  });

  it("breaks a tie the same way every time", () => {
    // The label exists to tell two menu rows apart. One that changed as the
    // pointer moved would fail at exactly that, so the tie may not fall to Map
    // iteration order.
    expect(dominantOwner(["f2", "f1"])).toBe("f1");
    expect(dominantOwner(["f1", "f2"])).toBe("f1");
  });

  it("has no answer when nothing was recorded", () => {
    // Normal, not exceptional: a backend that supplies no faceOwners at all.
    expect(dominantOwner(undefined)).toBeNull();
    expect(dominantOwner([])).toBeNull();
    expect(dominantOwner([null, null])).toBeNull();
  });
});

describe("edgeChoiceLabel", () => {
  it("reads from the general to the specific", () => {
    expect(edgeChoiceLabel("Body 02", "Extrusion 02")).toBe("Edge · Body 02 · Extrusion 02");
  });

  it("drops a feature that only repeats the body's name", () => {
    // Primitives name their body after themselves, so this came out as
    // "Edge · Box · Box": the second half spends the row's width saying the
    // same word again.
    expect(edgeChoiceLabel("Box", "Box")).toBe("Edge · Box");
    // ...and still dropped once the body has been numbered apart from its
    // namesake, which is the case that made this take the name separately.
    expect(edgeChoiceLabel("Box 2", "Box", "Box")).toBe("Edge · Box 2");
    // a feature that genuinely says something else survives
    expect(edgeChoiceLabel("Box 2", "Fillet 01", "Box")).toBe("Edge · Box 2 · Fillet 01");
  });

  it("drops what it does not know rather than filling it in", () => {
    // "Edge · unknown body" is noise wearing a fact's clothes.
    expect(edgeChoiceLabel("Body 02", null)).toBe("Edge · Body 02");
    expect(edgeChoiceLabel(null, "Extrusion 02")).toBe("Edge · Extrusion 02");
    expect(edgeChoiceLabel(null, null)).toBe("Edge");
    expect(edgeChoiceLabel("", "")).toBe("Edge");
  });
});

describe("distinguish", () => {
  it("leaves labels that already differ alone", () => {
    expect(distinguish(["Edge · Body 1", "Edge · Body 2"])).toEqual([
      "Edge · Body 1", "Edge · Body 2",
    ]);
  });

  it("numbers only the ones that collide", () => {
    // The last resort. Without it, two edges of one unnamed body would be
    // dropped as "not a real choice" and the user would be back to the
    // arbitrary pick this whole path exists to remove.
    expect(distinguish(["Edge", "Edge", "Edge · Body 2"])).toEqual([
      "Edge (1)", "Edge (2)", "Edge · Body 2",
    ]);
  });

  it("keeps the input's order and length", () => {
    const input = ["a", "b", "a", "c", "a"];
    const out = distinguish(input);
    expect(out).toHaveLength(input.length);
    expect(out).toEqual(["a (1)", "b", "a (2)", "c", "a (3)"]);
  });

  it("handles nothing at all", () => {
    expect(distinguish([])).toEqual([]);
  });
});

describe("bodyRowLabel", () => {
  it("uses the plain name when nothing else carries it", () => {
    expect(bodyRowLabel("Bracket", 3, false)).toBe("Bracket");
  });

  it("numbers by the body's place in the list, not by the menu row", () => {
    // "Box 2" in the menu has to mean the second Box in the browser, or the
    // number is a fact about this popup and nothing else.
    expect(bodyRowLabel("Box", 0, true)).toBe("Box 1");
    expect(bodyRowLabel("Box", 4, true)).toBe("Box 5");
  });

  it("has nothing to say about a body it cannot name", () => {
    expect(bodyRowLabel(null, 1, true)).toBeNull();
    expect(bodyRowLabel("", 1, true)).toBeNull();
  });

  it("leaves the name alone when the body is not in the list", () => {
    // findIndex returns -1 for a body the build result no longer carries;
    // "Box 0" would be a worse answer than "Box".
    expect(bodyRowLabel("Box", -1, true)).toBe("Box");
  });
});
