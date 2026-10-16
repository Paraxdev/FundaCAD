import { describe, expect, it } from "vitest";
import {
  clampFaceting, DEFAULT_SETTINGS, exportFileName, meshWire, parseExportSettings, refinementOf, REFINEMENTS,
} from "../../src/io/exportSettings";

describe("export settings", () => {
  it("names the preset a set of values matches, else custom", () => {
    expect(refinementOf(REFINEMENTS.high)).toBe("high");
    expect(refinementOf({ ...REFINEMENTS.high, maxEdgeLength: 2 })).toBe("custom");
  });

  it("clamps faceting to what the kernel accepts", () => {
    expect(clampFaceting({ surfaceDeviation: 0, normalDeviation: 400, maxEdgeLength: -1 }))
      .toEqual({ surfaceDeviation: 0.0001, normalDeviation: 90, maxEdgeLength: 0 });
    expect(clampFaceting({ surfaceDeviation: Number.NaN, normalDeviation: 15, maxEdgeLength: 3 }).surfaceDeviation)
      .toBe(REFINEMENTS.medium.surfaceDeviation);
  });

  it("sends units, format and faceting to the engine", () => {
    const s = { ...DEFAULT_SETTINGS, unit: "in" as const, binary: false, faceting: { surfaceDeviation: 0.01, normalDeviation: 10, maxEdgeLength: 5 } };
    expect(meshWire(s)).toEqual({ unit: "in", binary: false, surfaceDeviation: 0.01, normalDeviation: 10, maxEdgeLength: 5 });
  });

  it("reads saved choices back and survives junk", () => {
    expect(parseExportSettings(null)).toEqual(DEFAULT_SETTINGS);
    const back = parseExportSettings(JSON.stringify({ ...DEFAULT_SETTINGS, format: "3mf", unit: "cm", showAdvanced: true, faceting: { ...REFINEMENTS.low } }));
    expect(back.format).toBe("3mf");
    expect(back.unit).toBe("cm");
    expect(back.showAdvanced).toBe(true);
    expect(back.refinement).toBe("low");
    expect(parseExportSettings("{nope")).toEqual(DEFAULT_SETTINGS);
    expect(parseExportSettings(JSON.stringify({ format: "dwg", unit: "parsec" }))).toEqual(DEFAULT_SETTINGS);
  });
});

describe("export file name", () => {
  const at = new Date(2026, 9, 16, 9, 5, 7);

  it("adds the date and time to the second, so each export suggests a new file", () => {
    expect(exportFileName("bracket", "stl", at)).toBe("bracket_2026-10-16_09-05-07.stl");
    expect(exportFileName("bracket", "stl", new Date(2026, 9, 16, 9, 5, 8))).not.toBe(exportFileName("bracket", "stl", at));
  });

  it("makes a body or document name safe for Windows and never empty", () => {
    expect(exportFileName('a<b>:c"d/e\\f|g?h*', "step", at)).toBe("a_b__c_d_e_f_g_h__2026-10-16_09-05-07.step");
    expect(exportFileName("lid. ", "3mf", at)).toBe("lid_2026-10-16_09-05-07.3mf");
    expect(exportFileName("", "glb", at)).toBe("part_2026-10-16_09-05-07.glb");
  });
});
