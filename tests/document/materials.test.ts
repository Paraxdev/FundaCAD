// The pure half of materials: what a material is, what a library file may say,
// and what an arbitrary colour matches.
//
// The cases worth pinning are all about reading somebody ELSE'S file. A library
// is meant to travel, so the interesting inputs are hand-written JSON, an export
// from another tool, and a file that is nearly right, and the wrong answer to
// any of them is a material that can be assigned to a body and then changes
// nothing on screen.

import { describe, expect, it } from "vitest";
import {
  FINISH,
  STARTER_LIBRARY,
  asHex,
  colorName,
  finishOf,
  freshMaterialName,
  materialsForColors,
  nearestMaterial,
  nodeColors,
  normalizeMaterial,
  normalizeGraph,
  parseLibrary,
  serializeLibrary,
  slugId,
  type MaterialDef,
  uniqueId,
  finishLabel,
  isDefaultFinish,
} from "../../src/document/materials";

describe("asHex", () => {
  it("takes the spellings a person writes", () => {
    expect(asHex("#FF8800")).toBe("#ff8800");
    expect(asHex("ff8800")).toBe("#ff8800");
    expect(asHex("  #f80 ")).toBe("#ff8800"); // three-digit, expanded
  });

  it("refuses everything else", () => {
    for (const bad of ["", "red", "#ff88", "#gg8800", "rgb(1,2,3)", 12, null, undefined]) {
      expect(asHex(bad)).toBeNull();
    }
  });
});

describe("finishOf", () => {
  it("fills every default in, so the render path has no branches", () => {
    expect(finishOf(undefined)).toEqual({ ...FINISH });
    expect(finishOf({ id: "a", name: "A", color: "#fff" })).toEqual({ ...FINISH });
    expect(finishOf({ id: "a", name: "A", color: "#fff", roughness: 0.1 })).toEqual({
      ...FINISH, roughness: 0.1,
    });
  });

  it("carries the glass fields and leaves absent colours absent", () => {
    const f = finishOf({ id: "a", name: "A", color: "#fff", ior: 1.33, attenuationColor: "#2a8f6a" });
    expect(f.ior).toBe(1.33);
    expect(f.thickness).toBe("auto");
    expect(f.attenuationColor).toBe("#2a8f6a");
    expect("specularColor" in f).toBe(false);
  });
});

describe("isDefaultFinish", () => {
  it("is true only when nothing about the finish differs from no material", () => {
    expect(isDefaultFinish(finishOf(undefined))).toBe(true);
    const plain = { id: "a", name: "A", color: "#fff" };
    for (const extra of [
      { clearcoat: 1 }, { ior: 1.33 }, { thickness: 9 }, { attenuationColor: "#00ff00" }, { attenuationDistance: 5 },
      { dispersion: 1 }, { iridescence: 0.5 }, { specularColor: "#ff0000" },
      { surface: { kind: "noise" as const, scale: 4, amount: 0.5 } },
      { surfaceGraph: { nodes: [{ id: "o", type: "output" as const }], output: "o" } },
    ]) {
      expect(isDefaultFinish(finishOf({ ...plain, ...extra })), JSON.stringify(extra)).toBe(false);
    }
  });
});

describe("normalizeMaterial", () => {
  it("keeps a material with a colour and repairs the rest", () => {
    expect(normalizeMaterial({ name: "Anodised blue", colour: "#2244cc", roughness: 5 })).toEqual({
      id: "m-anodised-blue",
      name: "Anodised blue",
      color: "#2244cc",
      roughness: 1, // clamped, not refused
    });
  });

  it("carries a field it does not know through untouched, and still repairs the ones it does", () => {
    const flakes = { density: 0.3, tint: ["#fff", "#ccf"] };
    const out = normalizeMaterial({
      id: "m-x", name: "X", color: "#112233", roughness: 5, sheen: 0.4, anisotropy: { amount: 0.2, angle: 90 },
      flakes, scatter: "#aa0000", castsLight: true, metalness: "junk",
    });
    expect(out).toEqual({
      id: "m-x", name: "X", color: "#112233", roughness: 1,
      sheen: 0.4, anisotropy: { amount: 0.2, angle: 90 }, flakes, scatter: "#aa0000", castsLight: true,
    });
    expect(out).not.toHaveProperty("metalness");
  });

  it("does not let an unknown key reach the prototype or alias the input", () => {
    const raw = JSON.parse('{"id":"m-x","name":"X","color":"#112233","__proto__":{"polluted":1},"deep":{"a":[1]}}');
    const out = normalizeMaterial(raw) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out["polluted"]).toBeUndefined();
    expect(out["deep"]).toEqual({ a: [1] });
    expect(out["deep"]).not.toBe(raw.deep);
  });

  it("drops a row with no usable colour, which is a row that would do nothing", () => {
    expect(normalizeMaterial({ name: "Nameless", metalness: 1 })).toBeNull();
    expect(normalizeMaterial({ name: "Bad", color: "not a colour" })).toBeNull();
    expect(normalizeMaterial("a string")).toBeNull();
    // the control: the same row WITH a colour survives
    expect(normalizeMaterial({ name: "Bad", color: "#123456" })?.id).toBe("m-bad");
  });

  it("omits a finish field that equals the default, so a plain colour is three fields", () => {
    const m = normalizeMaterial({
      name: "Plain", color: "#abcdef",
      metalness: FINISH.metalness, roughness: FINISH.roughness, opacity: FINISH.opacity,
    })!;
    expect(Object.keys(m).sort()).toEqual(["color", "id", "name"]);
  });

  it("falls back to a name and an id rather than losing the material", () => {
    const m = normalizeMaterial({ color: "#010203" }, 4)!;
    expect(m.id).toBe("m-material-5");
    expect(m.name).toBe("m-material-5");
  });

  it("carries a clearcoat when it is set, and drops it at the default", () => {
    expect(normalizeMaterial({ name: "Glazed", color: "#eeeeee", clearcoat: 1 })!.clearcoat).toBe(1);
    expect(normalizeMaterial({ name: "Glazed", color: "#eeeeee", clearcoat: 5 })!.clearcoat).toBe(1); // clamped
    expect("clearcoat" in normalizeMaterial({ name: "Plain", color: "#eeeeee", clearcoat: 0 })!).toBe(false);
  });

  it("carries the glass and thin film fields, clamped to what they can mean", () => {
    const optics = {
      ior: 2.42, thickness: 12, dispersion: 5, attenuationColor: "#2A8F6A", attenuationDistance: 20,
      iridescence: 0.6, specularColor: "#ffd0a0",
    };
    expect(normalizeMaterial({ id: "d", name: "D", color: "#ffffff", ...optics })).toEqual({
      id: "d", name: "D", color: "#ffffff", ...optics, attenuationColor: "#2a8f6a",
    });
    const wild = normalizeMaterial({
      id: "w", name: "W", color: "#ffffff",
      ior: 9, thickness: -4, dispersion: 40, attenuationDistance: 1e9, iridescence: 3,
      attenuationColor: "green", specularColor: 7,
    })!;
    expect(wild).toEqual({
      id: "w", name: "W", color: "#ffffff", ior: 2.5, thickness: 0, dispersion: 10, attenuationDistance: 1000,
      iridescence: 1,
    });
    expect(normalizeMaterial({ id: "l", name: "L", color: "#ffffff", ior: 0.5 })!.ior).toBe(1);
  });

  it("omits every glass field at its default, so an old glass reads back as it was", () => {
    const old = { id: "m-glass", name: "Glass", color: "#cfe4ee", metalness: 0, roughness: 0.05, opacity: 0.25 };
    expect(normalizeMaterial({
      ...old, ior: 1.5, dispersion: 0, attenuationDistance: 0, iridescence: 0,
    })).toEqual(old);
    expect(normalizeMaterial(old)).toEqual(old);
  });

  it("keeps a stored thickness as an override and reads absent or junk as auto", () => {
    const base = { id: "g", name: "G", color: "#ffffff", opacity: 0.2 };
    for (const thickness of [3, 12, 0]) {
      expect(normalizeMaterial({ ...base, thickness })!.thickness, String(thickness)).toBe(thickness);
      expect(finishOf(normalizeMaterial({ ...base, thickness })!).thickness).toBe(thickness);
    }
    expect(normalizeMaterial({ ...base, thickness: -4 })!.thickness).toBe(0);
    for (const thickness of ["auto", "x", undefined, null, Number.NaN]) {
      const m = normalizeMaterial({ ...base, thickness })!;
      expect("thickness" in m, String(thickness)).toBe(false);
      expect(finishOf(m).thickness).toBe("auto");
    }
    expect(isDefaultFinish(finishOf({ id: "a", name: "A", color: "#fff", thickness: 3 }))).toBe(false);
    for (const preset of STARTER_LIBRARY.filter((m) => (m.opacity ?? 1) < 1)) {
      expect(finishOf(preset).thickness, preset.id).toBe("auto");
    }
  });

  it("carries a valid procedural surface and drops a broken one", () => {
    const m = normalizeMaterial({
      name: "Scratched", color: "#888888",
      surface: { kind: "scratches", scale: 8, amount: 0.6, bump: 0.5, color: "#111111", colorAmount: 0.4, angle: 1 },
    })!;
    expect(m.surface).toEqual({ kind: "scratches", scale: 8, amount: 0.6, bump: 0.5, color: "#111111", colorAmount: 0.4, angle: 1 });
    // a bad kind or a non-positive scale is not a surface
    expect(normalizeMaterial({ name: "X", color: "#888888", surface: { kind: "sparkles", scale: 8, amount: 0.5 } })!.surface).toBeUndefined();
    expect(normalizeMaterial({ name: "X", color: "#888888", surface: { kind: "noise", scale: 0, amount: 0.5 } })!.surface).toBeUndefined();
  });

  it("carries a shaped surface graph and drops a broken one", () => {
    const g = { output: "out", nodes: [{ id: "n", type: "noise" }, { id: "out", type: "output", in: { roughness: "n" } }] };
    expect(normalizeGraph(g)).toEqual(g);
    // dropped: output names no node, nodes not an array, unknown node type filtered
    expect(normalizeGraph({ output: "missing", nodes: [{ id: "n", type: "noise" }] })).toBeUndefined();
    expect(normalizeGraph({ output: "out", nodes: "nope" })).toBeUndefined();
    const filtered = normalizeGraph({ output: "out", nodes: [{ id: "bad", type: "sparkle" }, { id: "out", type: "output" }] });
    expect(filtered!.nodes.map((n) => n.id)).toEqual(["out"]);
  });
});

describe("slugId / uniqueId / freshMaterialName", () => {
  it("makes an id out of anything", () => {
    expect(slugId("Anodised Blue (matte)")).toBe("m-anodised-blue-matte");
    expect(slugId("!!!")).toBe("m-material");
  });

  it("suffixes only when it has to", () => {
    const taken = new Set(["m-a"]);
    expect(uniqueId("m-b", taken)).toBe("m-b");
    expect(uniqueId("m-a", taken)).toBe("m-a-2");
    expect(uniqueId("m-a", new Set(["m-a", "m-a-2"]))).toBe("m-a-3");
  });

  it("numbers a fresh name against the library, ignoring case", () => {
    const lib: MaterialDef[] = [{ id: "a", name: "copper", color: "#fff" }];
    expect(freshMaterialName(lib, "Copper")).toBe("Copper 2");
    expect(freshMaterialName(lib, "Brass")).toBe("Brass"); // the control
  });
});

describe("the starter library", () => {
  it("is already in normal form, so it round-trips and stays 'untouched'", () => {
    // Not cosmetic. A field equal to the default is dropped on read, so an entry
    // carrying one would come back different from what was written: an export
    // would not round-trip, and the store would decide a freshly reopened
    // document had a customised library and start writing it into every file.
    for (const m of STARTER_LIBRARY) {
      expect(normalizeMaterial(m)).toEqual(m);
    }
  });

  it("gives every entry a distinct id and a colour", () => {
    expect(new Set(STARTER_LIBRARY.map((m) => m.id)).size).toBe(STARTER_LIBRARY.length);
    for (const m of STARTER_LIBRARY) expect(asHex(m.color)).toBe(m.color);
  });
});

describe("parseLibrary", () => {
  it("round-trips what this app writes, byte for byte", () => {
    const json = serializeLibrary(STARTER_LIBRARY);
    const { materials, problem } = parseLibrary(json);
    expect(problem).toBeNull();
    expect(materials).toEqual([...STARTER_LIBRARY]);
    expect(serializeLibrary(materials)).toBe(json);
  });

  it("takes a bare array, which is what a person writes by hand", () => {
    const { materials } = parseLibrary('[{"name":"Ink","color":"#101010"}]');
    expect(materials).toEqual([{ id: "m-ink", name: "Ink", color: "#101010" }]);
  });

  it("keeps what was readable and says what it skipped", () => {
    const { materials, problem } = parseLibrary(
      '{"materials":[{"name":"A","color":"#ffffff"},{"name":"B"},{"name":"C"}]}',
    );
    expect(materials.map((m) => m.name)).toEqual(["A"]);
    expect(problem).toBe("2 of 3 had no usable colour and were skipped");
  });

  it("never throws on a file that is not a library", () => {
    expect(parseLibrary("{").materials).toEqual([]);
    expect(parseLibrary("{").problem).toMatch(/not readable as JSON/);
    expect(parseLibrary('{"hello":1}').problem).toMatch(/no materials in it/);
  });

  it("keeps two rows that want the same id, rather than losing one", () => {
    const { materials } = parseLibrary('[{"name":"Ink","color":"#111111"},{"name":"Ink","color":"#222222"}]');
    expect(materials.map((m) => m.id)).toEqual(["m-ink", "m-ink-2"]);
  });
});

describe("colorName", () => {
  it("names a colour roughly, which is what makes a library row legible", () => {
    expect(colorName("#b06a3b")).toBe("brown");
    expect(colorName("#2244cc")).toBe("blue");
    expect(colorName("#f4f4f4")).toBe("white");
    expect(colorName("#101010")).toBe("black");
  });

  it("says so rather than guessing when it cannot read the colour", () => {
    expect(colorName("nonsense")).toBe("colour");
  });
});

describe("nodeColors", () => {
  // A subassembly painted red holding parts with no colour of their own: the
  // parts are red, and reading the leaf alone would throw that away.
  const TREE = [
    { name: "Robot", parent: null },
    { name: "Arm", parent: 0, color: "#d23b30" },
    { name: "Bracket", parent: 1 },
    { name: "Pin", parent: 1, color: "#2244cc" },
    { name: "Base", parent: 0 },
  ];

  it("inherits from the nearest coloured ancestor", () => {
    expect(nodeColors(TREE)).toEqual([
      undefined,   // the root says nothing
      "#d23b30",   // its own
      "#d23b30",   // inherited from Arm
      "#2244cc",   // its own is preferred over the ancestor's
      undefined,   // nothing above it either
    ]);
  });

  it("terminates on a cycle in a hand-edited manifest", () => {
    expect(nodeColors([
      { parent: 1 },
      { parent: 0, color: "#010203" },
    ])).toEqual(["#010203", "#010203"]);
  });
});

describe("materialsForColors", () => {
  const lib: MaterialDef[] = [
    { id: "m-steel", name: "Steel", color: "#8f959b", metalness: 0.95 },
  ];

  it("reuses a material the document already has for that colour", () => {
    const { add, byColor } = materialsForColors([{ color: "#909699" }], lib);
    expect(add).toEqual([]);
    expect(byColor.get("#909699")).toBe("m-steel");
  });

  it("mints one, named for the colour, when nothing is close", () => {
    const { add, byColor } = materialsForColors([{ color: "#2244cc" }], lib);
    expect(add).toEqual([{ id: "m-imported-blue", name: "Imported blue", color: "#2244cc" }]);
    expect(byColor.get("#2244cc")).toBe("m-imported-blue");
  });

  it("prefers a name the file supplied", () => {
    const { add } = materialsForColors([{ color: "#2244cc", name: "Anodised blue" }], lib);
    expect(add[0]).toMatchObject({ id: "m-anodised-blue", name: "Anodised blue" });
  });

  it("does not mint two near-identical materials for one import", () => {
    // The case this exists for: an assembly whose parts are two shades of the
    // same grey would otherwise grow the library by one row per shade.
    const { add } = materialsForColors(
      [{ color: "#2244cc" }, { color: "#2345cd" }, { color: "#2244cc" }],
      lib,
    );
    expect(add).toHaveLength(1);
    // the control: a colour that is genuinely different does get its own
    expect(materialsForColors([{ color: "#2244cc" }, { color: "#22cc44" }], lib).add).toHaveLength(2);
  });

  it("keeps names and ids distinct against the library and against each other", () => {
    const clash: MaterialDef[] = [{ id: "m-imported-blue", name: "Imported blue", color: "#000000" }];
    const { add } = materialsForColors([{ color: "#2244cc" }], clash);
    expect(add[0]!.name).toBe("Imported blue 2");
    expect(add[0]!.id).not.toBe("m-imported-blue");
  });

  it("never lets an imported colour pick up a transparency the file never stated", () => {
    // The fault this catches, measured on the reference assembly: its circuit
    // board's pale lavender falls within tolerance of the stock Glass material,
    // so all fifteen occurrences opened at a quarter opacity and the board could
    // be seen through. A colour says nothing about transparency, so a see-through
    // material is never the answer to one.
    const glassy: MaterialDef[] = [
      { id: "m-glass", name: "Glass", color: "#cfe4ee", opacity: 0.25 },
    ];
    const { add, byColor } = materialsForColors([{ color: "#cad1ee" }], glassy);
    expect(add).toHaveLength(1);
    expect(add[0]!.color).toBe("#cad1ee");
    expect(add[0]!.opacity).toBeUndefined();
    expect(byColor.get("#cad1ee")).toBe(add[0]!.id);
  });

  it("still reuses an OPAQUE material of the same colour (control)", () => {
    // The control on the rule above: it must turn away see-through materials
    // only, not stop the matching that keeps the library from growing a row per
    // shade of grey.
    const both: MaterialDef[] = [
      { id: "m-glass", name: "Glass", color: "#cfe4ee", opacity: 0.25 },
      { id: "m-pale", name: "Pale", color: "#cfe4ee" },
    ];
    expect(materialsForColors([{ color: "#cad1ee" }], both).byColor.get("#cad1ee")).toBe("m-pale");
  });

  it("skips a colour it cannot read rather than assigning something", () => {
    const { add, byColor } = materialsForColors([{ color: "not a colour" }], lib);
    expect(add).toEqual([]);
    expect(byColor.size).toBe(0);
  });
});

describe("nearestMaterial", () => {
  const lib: MaterialDef[] = [
    { id: "w", name: "White", color: "#ffffff" },
    { id: "k", name: "Black", color: "#000000" },
    { id: "r", name: "Red", color: "#d23b30" },
  ];

  it("matches a shade of a colour that is in the library", () => {
    expect(nearestMaterial("#f8f8f8", lib)?.id).toBe("w");
    expect(nearestMaterial("#d5423a", lib)?.id).toBe("r");
  });

  it("answers null rather than the least wrong of what it has", () => {
    // Mid grey is 128 from both white and black in every channel, far outside
    // the tolerance. A palette would have to name one of them; a library says
    // this is a new material.
    expect(nearestMaterial("#808080", lib)).toBeNull();
    // the control: raise the tolerance past that distance and it does match
    expect(nearestMaterial("#808080", lib, 3 * 255 * 255)).not.toBeNull();
  });

  it("is null on an empty library and on a colour it cannot read", () => {
    expect(nearestMaterial("#ffffff", [])).toBeNull();
    expect(nearestMaterial("not a colour", lib)).toBeNull();
  });
});

describe("glow", () => {
  it("is off unless a material says otherwise", () => {
    expect(finishOf(undefined).emissive).toBe(0);
    expect(finishOf({ id: "m", name: "M", color: "#808080" }).emissive).toBe(0);
    expect(FINISH.emissive).toBe(0);
  });

  it("survives a library file round trip, and is dropped when it is the default", () => {
    // Omit-when-default is what keeps a plain colour three fields on disk, and
    // the starter library in normal form.
    expect(normalizeMaterial({ id: "m-led", name: "LED", color: "#42e07a", emissive: 0.8 }))
      .toEqual({ id: "m-led", name: "LED", color: "#42e07a", emissive: 0.8 });
    expect(normalizeMaterial({ id: "m", name: "M", color: "#808080", emissive: 0 }))
      .toEqual({ id: "m", name: "M", color: "#808080" });
  });

  it("clamps a value from a file somebody else wrote", () => {
    expect(normalizeMaterial({ id: "m", name: "M", color: "#808080", emissive: 40 })!.emissive)
      .toBe(1);
    expect(normalizeMaterial({ id: "m", name: "M", color: "#808080", emissive: -3 }))
      .toEqual({ id: "m", name: "M", color: "#808080" });
    expect(normalizeMaterial({ id: "m", name: "M", color: "#808080", emissive: "bright" }))
      .toEqual({ id: "m", name: "M", color: "#808080" });
  });

  it("has exactly one entry in the starter library that glows", () => {
    // One, so the slider is discoverable, and only one, because a starter
    // library is a set of examples and a part that emits light is not ordinary
    // stuff.
    const lit = STARTER_LIBRARY.filter((m) => (m.emissive ?? 0) > 0);
    expect(lit.map((m) => m.name)).toEqual(["Indicator, lit"]);
  });
});

describe("finishLabel", () => {
  it("says how polished a surface is", () => {
    expect(finishLabel({ id: "a", name: "A", color: "#888", roughness: 0.05 })).toBe("Glossy");
    expect(finishLabel({ id: "a", name: "A", color: "#888", roughness: 0.3 })).toBe("Satin");
    expect(finishLabel({ id: "a", name: "A", color: "#888", roughness: 0.9 })).toBe("Matte");
  });

  it("adds what KIND of stuff it is, when it is worth saying", () => {
    expect(finishLabel({ id: "a", name: "A", color: "#888", metalness: 0.9, roughness: 0.1 }))
      .toBe("Glossy, metallic");
    expect(finishLabel({ id: "a", name: "A", color: "#888", opacity: 0.3, roughness: 0.1 }))
      .toBe("Glossy, transparent");
    expect(finishLabel({ id: "a", name: "A", color: "#888", emissive: 0.5, roughness: 0.3 }))
      .toBe("Satin, lit");
  });

  it("picks ONE kind, most-visible first, rather than listing three", () => {
    // Shiny and see-through and metallic on paper. A phrase saying all three is
    // read by nobody, and what changes the picture most is that you can see
    // through it.
    expect(finishLabel({
      id: "a", name: "A", color: "#888", metalness: 0.9, opacity: 0.3, roughness: 0.05,
    })).toBe("Glossy, transparent");
    // ...unless it is also giving off light, which is preferred over everything.
    expect(finishLabel({
      id: "a", name: "A", color: "#888", metalness: 0.9, opacity: 0.3, emissive: 1, roughness: 0.05,
    })).toBe("Glossy, lit");
  });

  it("describes a material that says nothing about itself by the app default", () => {
    // FINISH is roughness 0.55, metalness 0.1: matt, and not metal.
    expect(finishLabel({ id: "a", name: "A", color: "#888" })).toBe("Matte");
    expect(finishLabel(undefined)).toBe("Matte");
  });

  it("never says a dash, which is the house rule for every string a user reads", () => {
    // Written by code point so this file does not itself contain the character
    // the repo hygiene check bans.
    const EM = String.fromCharCode(0x2014);
    for (const m of STARTER_LIBRARY) {
      expect(finishLabel(m)).not.toContain(EM);
      expect(finishLabel(m)).not.toContain(" - ");
    }
  });
});

