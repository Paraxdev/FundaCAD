import { describe, expect, it } from "vitest";

import { FILAMENT_GROUP, FILAMENT_PRESETS } from "../../plugins/FundaCAD.PrintLook/presets";
import { normalizeMaterial } from "../../src/document/materials";
import { materialPreview } from "../../src/viewport/materialPreview";

const BANNED = /printer|slicer|\borca|bambu|moonraker|octoprint|prusa|klipper|snapmaker|\bqidi\b|toolhead|\bb?g-?code\b/i;

describe("the filament presets", () => {
  it("are the eight classes, in one group", () => {
    expect(FILAMENT_GROUP).toBe("Filament");
    expect(FILAMENT_PRESETS.map((m) => m.name)).toEqual([
      "PLA, matte",
      "PLA, glossy",
      "PLA, silk",
      "PETG, translucent",
      "PLA, carbon fibre fill",
      "PLA, wood fill",
      "PLA, glow",
      "TPU",
    ]);
  });

  it("are each in normal form, so a copy in a document round-trips", () => {
    for (const m of FILAMENT_PRESETS) expect(normalizeMaterial(m), m.id).toEqual(m);
  });

  it("have unique ids and names free of the core word list", () => {
    const ids = FILAMENT_PRESETS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of FILAMENT_PRESETS) {
      expect(BANNED.test(m.name), m.name).toBe(false);
      expect(BANNED.test(m.id), m.id).toBe(false);
    }
  });

  it("each preview through materialPreview without throwing", () => {
    for (const m of FILAMENT_PRESETS) expect(() => materialPreview(m), m.id).not.toThrow();
  });

  it("make glow a pale tint that shines but lights nothing else", () => {
    const glow = FILAMENT_PRESETS.find((m) => m.name === "PLA, glow")!;
    expect(glow.emissive).toBeCloseTo(0.35);
    expect(glow.castsLight).toBe(false);
  });

  it("draw wood fill from a voronoi speck graph at 0.4 mm", () => {
    const wood = FILAMENT_PRESETS.find((m) => m.name === "PLA, wood fill")!;
    const g = wood.surfaceGraph!;
    const v = g.nodes.find((n) => n.type === "voronoi")!;
    expect(v.params?.["scale"]).toBe(0.4);
    expect(g.nodes.some((n) => n.params?.["colorB"] === "#6b4a2c" || n.params?.["colorA"] === "#6b4a2c")).toBe(true);
    expect(g.nodes.some((n) => n.id === g.output && n.type === "output")).toBe(true);
  });

  it("give silk its stretched highlight in its own colour", () => {
    const silk = FILAMENT_PRESETS.find((m) => m.name === "PLA, silk")!;
    expect(silk.anisotropy).toBe(0.6);
    expect(silk.specularColor).toBe(silk.color);
  });
});
