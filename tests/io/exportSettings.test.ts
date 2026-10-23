import { describe, expect, it } from "vitest";
import {
  clampFaceting,
  DEFAULT_SETTINGS,
  exportFileName,
  isFlatFormat,
  isMeshFormat,
  meshWire,
  parseExportSettings,
  refinementOf,
  REFINEMENTS,
  takesUnit,
} from "../../src/io/exportSettings";

describe("export settings", () => {
  it("names the preset a set of values matches, else custom", () => {
    expect(refinementOf(REFINEMENTS.high)).toBe("high");
    expect(refinementOf({ ...REFINEMENTS.high, maxEdgeLength: 2 })).toBe("custom");
  });

  it("clamps faceting to what the kernel accepts", () => {
    expect(clampFaceting({ surfaceDeviation: 0, normalDeviation: 400, maxEdgeLength: -1 })).toEqual({
      surfaceDeviation: 0.0001,
      normalDeviation: 90,
      maxEdgeLength: 0,
    });
    expect(
      clampFaceting({ surfaceDeviation: Number.NaN, normalDeviation: 15, maxEdgeLength: 3 }).surfaceDeviation,
    ).toBe(REFINEMENTS.medium.surfaceDeviation);
  });

  it("sends units, format and faceting to the engine", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      unit: "in" as const,
      binary: false,
      faceting: { surfaceDeviation: 0.01, normalDeviation: 10, maxEdgeLength: 5 },
    };
    expect(meshWire(s)).toEqual({
      unit: "in",
      binary: false,
      surfaceDeviation: 0.01,
      normalDeviation: 10,
      maxEdgeLength: 5,
    });
  });

  it("reads saved choices back and survives junk", () => {
    expect(parseExportSettings(null)).toEqual(DEFAULT_SETTINGS);
    const back = parseExportSettings(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        format: "3mf",
        unit: "cm",
        showAdvanced: true,
        faceting: { ...REFINEMENTS.low },
      }),
    );
    expect(back.format).toBe("3mf");
    expect(back.unit).toBe("cm");
    expect(back.showAdvanced).toBe(true);
    expect(back.refinement).toBe("low");
    expect(parseExportSettings("{nope")).toEqual(DEFAULT_SETTINGS);
    expect(parseExportSettings(JSON.stringify({ format: "dwg", unit: "parsec" }))).toEqual(DEFAULT_SETTINGS);
  });
});

describe("DXF and SVG", () => {
  it("are drawings, not meshes, and take no unit or faceting", () => {
    for (const f of ["dxf", "svg"] as const) {
      expect([isFlatFormat(f), isMeshFormat(f), takesUnit(f)]).toEqual([true, false, false]);
    }
    expect(["stl", "3mf", "glb", "step"].map((f) => isFlatFormat(f as "stl"))).toEqual([false, false, false, false]);
    expect(["stl", "3mf", "glb", "step"].map((f) => isMeshFormat(f as "stl"))).toEqual([true, true, true, false]);
  });

  it("remember the tolerance, clamped to what the engine accepts", () => {
    expect(parseExportSettings(JSON.stringify({ ...DEFAULT_SETTINGS, format: "svg", tolerance: 0.05 }))).toMatchObject({
      format: "svg",
      tolerance: 0.05,
    });
    expect(parseExportSettings(JSON.stringify({ ...DEFAULT_SETTINGS, tolerance: 50 })).tolerance).toBe(1);
    expect(parseExportSettings(JSON.stringify({ ...DEFAULT_SETTINGS, tolerance: "x" })).tolerance).toBe(0.01);
  });
});

describe("export file name", () => {
  const at = new Date(2026, 9, 16, 9, 5, 7);

  it("adds the date and time to the second, so each export suggests a new file", () => {
    expect(exportFileName("bracket", "stl", at)).toBe("bracket_20261016090507.stl");
    expect(exportFileName("bracket", "stl", new Date(2026, 9, 16, 9, 5, 8))).not.toBe(
      exportFileName("bracket", "stl", at),
    );
  });

  it("makes a body or document name safe for Windows and never empty", () => {
    expect(exportFileName('a<b>:c"d/e\\f|g?h*', "step", at)).toBe("a_b__c_d_e_f_g_h__20261016090507.step");
    expect(exportFileName("lid. ", "3mf", at)).toBe("lid_20261016090507.3mf");
    expect(exportFileName("", "glb", at)).toBe("part_20261016090507.glb");
  });
});
