import { describe, expect, it } from "vitest";
import manifest from "../../plugins/FundaCAD.PrintToolbox/manifest.json";
import {
  PRINT_TOOLS, SACRIFICIAL_LAYER, TEARDROP, COUNTERBORE_BRIDGE, faceSelectors, featureFor, toolById,
} from "../../plugins/FundaCAD.PrintToolbox/printForm";

describe("the toolbox's tools", () => {
  it("each own one of the manifest's feature types, and together all of them", () => {
    expect(PRINT_TOOLS.map((t) => t.type).sort()).toEqual([...manifest.featureTypes].sort());
    expect(new Set(PRINT_TOOLS.map((t) => t.id)).size).toBe(PRINT_TOOLS.length);
    expect(toolById("print-teardrop")).toBe(TEARDROP);
    expect(toolById("texture")).toBeNull();
  });

  it("give every numeric row a default, so a new feature shows what it will build", () => {
    for (const t of PRINT_TOOLS) {
      for (const [field] of t.numFields) expect(t.defaults, `${t.type}.${field}`).toHaveProperty(field);
    }
  });

  it("offer a choice's fallback among its own options", () => {
    for (const t of PRINT_TOOLS) {
      for (const c of t.choiceFields) {
        expect(c.options.map((o) => o.value), `${t.type}.${c.field}`).toContain(c.fallback);
      }
    }
  });
});

describe("featureFor", () => {
  const pick = { point: [1, 2, 3] as [number, number, number], body: "b1" };

  it("is null with nothing picked", () => {
    expect(featureFor(TEARDROP, "f1", [], "+Z")).toBeNull();
  });

  it("writes one pick as a bare selector stamped with its body, the defaults, and the build direction", () => {
    expect(featureFor(TEARDROP, "f7", [pick], "-Y")).toEqual({
      id: "f7",
      type: "teardropHole",
      faces: { kind: "face", by: "nearest", point: [1, 2, 3], body: "b1" },
      angle: 45,
      roof: "pointed",
      flatHeight: 0,
      buildDir: "-Y",
    });
  });

  it("keeps several picks as a list, and leaves a body off a pick that has none", () => {
    const f = featureFor(SACRIFICIAL_LAYER, "f2", [pick, { point: [4, 5, 6], body: null }], "+Z") as unknown as Record<string, unknown>;
    expect(f["faces"]).toEqual(faceSelectors([pick, { point: [4, 5, 6], body: null }]));
    expect((f["faces"] as unknown[])[1]).toEqual({ kind: "face", by: "nearest", point: [4, 5, 6] });
    expect(f).toMatchObject({ layerHeight: 0.2, layers: 1, depth: 0, side: "bottom", buildDir: "+Z" });
  });

  it("records no build direction for a tool that does not read one", () => {
    const f = featureFor(COUNTERBORE_BRIDGE, "f3", [pick], "+X") as unknown as Record<string, unknown>;
    expect(f).not.toHaveProperty("buildDir");
    expect(f).toMatchObject({ layerHeight: 0.2, layers: 2, angle: 0 });
  });
});

describe("the teardrop's rows", () => {
  it("show the flat height only under a flat roof", () => {
    expect(TEARDROP.fieldApplies!("flatHeight", { roof: "flat" })).toBe(true);
    expect(TEARDROP.fieldApplies!("flatHeight", { roof: "pointed" })).toBe(false);
    expect(TEARDROP.fieldApplies!("flatHeight", {})).toBe(false);
    expect(TEARDROP.fieldApplies!("angle", { roof: "pointed" })).toBe(true);
  });
});
