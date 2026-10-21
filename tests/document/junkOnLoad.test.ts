// Lists in a hand edited or damaged file: an entry that cannot be read is
// dropped on open, the readable ones come through as they were.
import { describe, expect, it, vi } from "vitest";
import { UnreadableDocumentError } from "../../src/document/documentShape";
import { box, freshStore, opened, saved } from "./storeKit";

vi.stubGlobal("window", globalThis);

type Store = ReturnType<typeof opened>;
const lists: [string, unknown, (s: Store) => unknown, unknown][] = [
  ["referenceImages", [], (s) => s.referenceImages(), []],
  ["referenceImages", [{ id: "r1", src: "a.png", x: 2.5 }], (s) => s.referenceImages(), [{ id: "r1", src: "a.png", x: 2.5 }]],
  [
    "referenceImages",
    [null, { id: "r1", src: "a.png" }, 7, "s", true, [], [{ id: "q" }], { id: "" }, { id: 3 }, { id: "r1", dup: 1 }, { id: "r2" }],
    (s) => s.referenceImages(),
    [{ id: "r1", src: "a.png" }, { id: "r2" }],
  ],
  ["elements", [], (s) => s.bodyElements, []],
  [
    "elements",
    [{ id: 5, name: "n" }, null, { id: "" }, { id: "e1", name: " " }, { id: "e2", name: "Lid", parent: "" }, { id: "e3", parent: "e2", x: 1 }],
    (s) => s.bodyElements,
    [{ id: "e1", name: "e1" }, { id: "e2", name: "Lid" }, { x: 1, id: "e3", name: "e3", parent: "e2" }],
  ],
  [
    "materials",
    [{ id: "x" }, null, 4, { name: "Red", color: "#c03020" }],
    (s) => s.materialLibrary,
    [{ id: "m-red", name: "Red", color: "#c03020" }],
  ],
  ["bodyIds", { "sk1:0": 5 }, (s) => s.document.bodyIds, undefined],
  ["bodyIds", ["body1"], (s) => s.document.bodyIds, undefined],
  ["bodyIds", { "sk1:0": "body1", "sk1:1": "body4" }, (s) => s.document.bodyIds, { "sk1:0": "body1", "sk1:1": "body4" }],
];

describe("junk entries in a file's lists", () => {
  for (const [key, value, read, want] of lists) {
    it(`${key} ${JSON.stringify(value)} opens with what is readable`, () => {
      const s = opened({ features: [box("f1", 10.5)], [key]: value });
      expect(read(s)).toEqual(want);
      const back = opened(saved(s));
      expect(read(back)).toEqual(want);
      expect(back.document.features).toEqual([box("f1", 10.5)]);
    });
  }

  it("a damaged modelling step makes the file unreadable and names the step", () => {
    for (const [features, at] of [[[box("f1", 1), null], "features[1]"], [[5], "features[0]"], [[box("f1", 1), { id: "x" }], "features[1]"]] as const) {
      const s = freshStore();
      let err: unknown = null;
      try { s.load(JSON.stringify({ parameters: {}, features })); } catch (e) { err = e; }
      expect(err, JSON.stringify(features)).toBeInstanceOf(UnreadableDocumentError);
      expect((err as Error).message).toContain(at);
    }
  });
});
