// Lists in a hand edited or damaged file: an entry that cannot be read is
// dropped on open, the readable ones come through as they were.
import { describe, expect, it, vi } from "vitest";
import { UnreadableDocumentError } from "../../src/document/documentShape";
import { STARTER_LIBRARY } from "../../src/document/materials";
import { box, freshStore, opened, saved } from "./storeKit";

vi.stubGlobal("window", globalThis);

const DEFAULT_PALETTE = [
  { name: "White", color: "#e8e8e8" },
  { name: "Black", color: "#202020" },
  { name: "Red", color: "#d23b30" },
  { name: "Blue", color: "#3050c8" },
];

type Store = ReturnType<typeof opened>;
const lists: [string, unknown, (s: Store) => unknown, unknown][] = [
  ["referenceImages", [], (s) => s.referenceImages(), []],
  [
    "referenceImages",
    [{ id: "r1", src: "a.png", x: 2.5 }],
    (s) => s.referenceImages(),
    [{ id: "r1", src: "a.png", x: 2.5 }],
  ],
  [
    "referenceImages",
    [
      null,
      { id: "r1", src: "a.png" },
      7,
      "s",
      true,
      [],
      [{ id: "q" }],
      { id: "" },
      { id: 3 },
      { id: "r1", dup: 1 },
      { id: "r2" },
    ],
    (s) => s.referenceImages(),
    [{ id: "r1", src: "a.png" }, { id: "r2" }],
  ],
  ["elements", [], (s) => s.bodyElements, []],
  [
    "elements",
    [
      { id: 5, name: "n" },
      null,
      { id: "" },
      { id: "e1", name: " " },
      { id: "e2", name: "Lid", parent: "" },
      { id: "e3", parent: "e2", x: 1 },
    ],
    (s) => s.bodyElements,
    [
      { id: "e1", name: "e1" },
      { id: "e2", name: "Lid" },
      { x: 1, id: "e3", name: "e3", parent: "e2" },
    ],
  ],
  [
    "materials",
    [{ id: "x" }, null, 4, { name: "Red", color: "#c03020" }],
    (s) => s.materialLibrary,
    [{ id: "m-red", name: "Red", color: "#c03020" }],
  ],
  ["materials", [{ id: "x" }, null], (s) => s.materialLibrary, STARTER_LIBRARY],
  [
    "palette",
    [
      null,
      { name: "Teal", color: "#10a0b0" },
      7,
      { name: "", color: "nope", material: 5 },
      { name: "Mint", color: "#0FA", material: "PLA", extra: 2 },
      [],
    ],
    (s) => s.colorPalette,
    [
      { name: "White", color: "#e8e8e8" },
      { name: "Teal", color: "#10a0b0" },
      { name: "Red", color: "#d23b30" },
      { name: "Blue", color: "#3050c8" },
      { extra: 2, name: "Mint", color: "#00ffaa", material: "PLA" },
      { name: "Colour 6", color: "#9a9a9a" },
    ],
  ],
  ["palette", "teal", (s) => s.colorPalette, DEFAULT_PALETTE],
  ["palette", { name: "Teal", color: "#10a0b0" }, (s) => s.colorPalette, DEFAULT_PALETTE],
  [
    "bodyNames",
    { b1: "Lid", b2: 5, b3: "", b4: null, b5: "  ", b6: "Base", b7: ["x"] },
    (s) => s.bodyNamesMap(),
    { b1: "Lid", b6: "Base" },
  ],
  ["bodyNames", "abc", (s) => s.bodyNamesMap(), {}],
  ["bodyNames", ["Lid"], (s) => s.bodyNamesMap(), {}],
  [
    "bodyColors",
    { b1: 2, b2: "1", b3: null, b4: -1, b5: 1.5, b6: 0, b7: Number.MAX_SAFE_INTEGER },
    (s) => s.bodyColorsMap(),
    { b1: 2, b6: 0, b7: Number.MAX_SAFE_INTEGER },
  ],
  [
    "bodyVisibility",
    { b1: false, b2: "no", b3: null, b4: 0, b5: true },
    (s) => saved(s).bodyVisibility,
    { b1: false, b5: true },
  ],
  ["suppressed", ["f2", 3, null, "f1"], (s) => saved(s).suppressed, ["f2", "f1"]],
  ["suppressed", "f1", (s) => saved(s).suppressed, undefined],
  ["rollback", "x", (s) => s.rollbackIndex, 2],
  ["rollback", -1, (s) => s.rollbackIndex, 2],
  ["rollback", 1.5, (s) => s.rollbackIndex, 2],
  ["rollback", null, (s) => s.rollbackIndex, 2],
  ["rollback", 0, (s) => s.rollbackIndex, 0],
  ["rollback", 1, (s) => s.rollbackIndex, 1],
  [
    "viewOverrides",
    {
      front: { normal: [0, 1, 0], up: [0, 0, 1] },
      back: null,
      top: { normal: [1, 2], up: [0, 0, 1] },
      left: { normal: [0, "x", 1], up: [0, 0, 1] },
      bottom: { normal: [0, 0, -1] },
      diag: { normal: [0, 1, 0], up: [0, 0, 1] },
      right: { normal: [0.6, -0.8, 0], up: [0, 0, 1] },
    },
    (s) => s.document.viewOverrides,
    { front: { normal: [0, 1, 0], up: [0, 0, 1] }, right: { normal: [0.6, -0.8, 0], up: [0, 0, 1] } },
  ],
  ["viewOverrides", { back: null, left: 5 }, (s) => s.document.viewOverrides, undefined],
  ["viewOverrides", [{ normal: [0, 1, 0], up: [0, 0, 1] }], (s) => s.document.viewOverrides, undefined],
  ["bodyIds", { "sk1:0": 5 }, (s) => s.document.bodyIds, undefined],
  ["bodyIds", ["body1"], (s) => s.document.bodyIds, undefined],
  [
    "bodyIds",
    { "sk1:0": "body1", "sk1:1": "body4" },
    (s) => s.document.bodyIds,
    { "sk1:0": "body1", "sk1:1": "body4" },
  ],
];

describe("junk entries in a file's lists", () => {
  for (const [key, value, read, want] of lists) {
    it(`${key} ${JSON.stringify(value)} opens with what is readable`, () => {
      const s = opened({ features: [box("f1", 10.5), box("f2", 4.25)], [key]: value });
      expect(read(s)).toEqual(want);
      const back = opened(saved(s));
      expect(read(back)).toEqual(want);
      expect(back.document.features).toEqual([box("f1", 10.5), box("f2", 4.25)]);
    });
  }

  it("a materials list with no readable row opens as the starter set and saves without a materials block", () => {
    for (const materials of [[{ id: "x" }, null], [7], "Steel", { id: "x", color: "#c03020" }]) {
      const s = opened({ materials });
      expect(s.materialLibrary, JSON.stringify(materials)).toEqual(STARTER_LIBRARY);
      expect(saved(s)).not.toHaveProperty("materials");
    }
  });

  it("a second document opened on the same store carries nothing of the junk of the first", () => {
    const s = opened({
      features: [box("f1", 10.5), box("f2", 4.25)],
      palette: [null, { name: "Teal", color: "#10a0b0" }],
      materials: [{ id: "x" }],
      bodyNames: { b1: 5, b2: "Lid" },
      bodyColors: { b1: 3, b2: "x" },
      rollback: 1,
      suppressed: ["f1"],
      viewOverrides: { front: { normal: [0, 1, 0], up: [0, 0, 1] } },
    });
    expect(s.colorPalette[1]).toEqual({ name: "Teal", color: "#10a0b0" });
    s.load(
      JSON.stringify({
        parameters: {},
        features: [box("g1", 2.5)],
        palette: [{ name: "Ink", color: "#102030" }],
        bodyNames: { c1: "Rim" },
        rollback: "x",
        viewOverrides: [],
      }),
    );
    expect(s.colorPalette).toEqual([{ name: "Ink", color: "#102030" }]);
    expect(s.bodyNamesMap()).toEqual({ c1: "Rim" });
    expect(s.bodyColorsMap()).toEqual({});
    expect(s.materialLibrary).toEqual(STARTER_LIBRARY);
    expect(s.rollbackIndex).toBe(1);
    expect(s.isSuppressed("f1")).toBe(false);
    expect(s.document.viewOverrides).toBeUndefined();
    expect(saved(s)).not.toHaveProperty("rollback");
    expect(saved(s)).not.toHaveProperty("suppressed");
  });

  it("a damaged modelling step makes the file unreadable and names the step", () => {
    for (const [features, at] of [
      [[box("f1", 1), null], "features[1]"],
      [[5], "features[0]"],
      [[box("f1", 1), { id: "x" }], "features[1]"],
    ] as const) {
      const s = freshStore();
      let err: unknown = null;
      try {
        s.load(JSON.stringify({ parameters: {}, features }));
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(features)).toBeInstanceOf(UnreadableDocumentError);
      expect((err as Error).message).toContain(at);
    }
  });
});
