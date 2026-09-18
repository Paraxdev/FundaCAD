import { describe, expect, it } from "vitest";
import {
  clampFaceting, DEFAULT_SETTINGS, meshWire, parseExportSettings, refinementOf, REFINEMENTS,
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
