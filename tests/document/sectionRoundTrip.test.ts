// The optional sections of a document file: what is read comes back on save,
// what the user deleted stays deleted, and what this version cannot read is
// written back as it came.
import { describe, expect, it, vi } from "vitest";
import type { ViewOverride } from "../../src/types";
import { box, env, opened, reopened, saved, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

const B = { features: [box("g1", 3.5)] };
const slanted: ViewOverride = { normal: [0.6, -0.48, 0.64], up: [0, 0.8, 0.6] };
const tilted: ViewOverride = { normal: [-0.36, 0.48, 0.8], up: [0.8, 0.6, 0] };

describe("the stress study", () => {
  it("round trips, stays deleted, and is not saved into the next document", () => {
    const s = opened({ features: [box("f1", 10.5)], stress: study });
    expect(saved(s).stress).toEqual(study);
    expect(reopened(s).stressStudy).toEqual(study);
    s.setStressStudy(null);
    expect("stress" in saved(s)).toBe(false);
    expect(reopened(s).stressStudy).toBeNull();
    s.setStressStudy(study);
    s.load(JSON.stringify({ parameters: {}, ...B }));
    expect("stress" in saved(s)).toBe(false);
  });

  it("from a newer version is written back whole while the document has none of its own", () => {
    const future = { future: true, nodes: [1.5, 2, 3] };
    const s = opened({ stress: future });
    expect(s.stressStudy).toBeNull();
    expect(saved(s).stress).toEqual(future);
    expect(saved(reopened(s)).stress).toEqual(future);
    s.setStressStudy(study);
    expect(saved(s).stress).toEqual(study);
  });
});

describe("the environment", () => {
  const studio = { name: "Studio", settings: { exposure: 1.75, blur: 0.3 } };

  it("round trips, stays deleted, and is not saved into the next document", () => {
    const s = opened({ environment: studio });
    expect(saved(s).environment).toEqual(studio);
    expect(reopened(s).documentEnvironment).toEqual(studio);
    s.setDocumentEnvironment(null);
    expect("environment" in saved(s)).toBe(false);
    expect(reopened(s).documentEnvironment).toBeNull();
    s.setDocumentEnvironment(env(2));
    s.load(JSON.stringify({ parameters: {}, ...B }));
    expect("environment" in saved(s)).toBe(false);
  });

  it("from a newer version is written back whole while the document has none of its own", () => {
    const future = { name: "future", sky: 3 };
    const s = opened({ environment: future });
    expect(s.documentEnvironment).toBeNull();
    expect(saved(s).environment).toEqual(future);
    expect(saved(reopened(s)).environment).toEqual(future);
    s.setDocumentEnvironment(env(0.5));
    expect(saved(s).environment).toEqual({ settings: { exposure: 0.5 } });
  });
});

describe("view overrides", () => {
  it("round trip, one side cleared then the last, and none leak into the next document", () => {
    const s = opened({ viewOverrides: { top: slanted, front: tilted } });
    expect(s.document.viewOverrides).toEqual({ top: slanted, front: tilted });
    expect(saved(s).viewOverrides).toEqual({ top: slanted, front: tilted });
    expect(reopened(s).viewOverrides).toEqual({ top: slanted, front: tilted });
    s.setViewOverride("front", null);
    expect(saved(reopened(s)).viewOverrides).toEqual({ top: slanted });
    s.setViewOverride("top", null);
    expect("viewOverrides" in saved(s)).toBe(false);
    s.setViewOverride("left", tilted);
    s.load(JSON.stringify({ parameters: {}, ...B }));
    expect(s.viewOverrides).toEqual({});
    expect("viewOverrides" in saved(s)).toBe(false);
  });
});

describe("the palette", () => {
  it("is left out while untouched, and saved once a slot no body uses is recoloured", () => {
    const s = opened({});
    expect(s.paletteIsDefault()).toBe(true);
    expect("palette" in saved(s)).toBe(false);
    const color = s.colorPalette[3]!.color.toLowerCase() === "#2a7f3c" ? "#7a1f5c" : "#2a7f3c";
    s.setPaletteSlot(3, { color });
    expect(s.paletteIsDefault()).toBe(false);
    const back = reopened(s);
    expect((saved(s).palette as { color: string }[])[3]!.color).toBe(color);
    expect(back.colorPalette).toEqual(s.colorPalette);
  });

  it("round trips a file's own palette, and the next document gets the default back", () => {
    const own = [
      { name: "Slate", color: "#3c4a5b" },
      { name: "Rust", color: "#a0522d", material: "m1" },
    ];
    const s = opened({ palette: own });
    expect(s.colorPalette).toEqual(own);
    expect(saved(s).palette).toEqual(own);
    s.load(JSON.stringify({ parameters: {}, ...B }));
    expect(s.paletteIsDefault()).toBe(true);
    expect("palette" in saved(s)).toBe(false);
  });
});
