// The filament-estimate math (mass + length), kept pure of Vue/Three/the
// geometry backend so it is testable without a viewport or a sidecar.

import { describe, it, expect } from "vitest";
import {
  MATERIAL_PRESETS,
  densityFor,
  estimateEffectiveVolume,
  estimateFilament,
  filamentLengthMm,
  CUSTOM_MATERIAL_ID,
} from "../../src/features/filamentEstimate";

describe("densityFor", () => {
  it("looks up a preset's density", () => {
    expect(densityFor("pla", 99)).toBeCloseTo(1.24);
    expect(densityFor("petg", 99)).toBeCloseTo(1.27);
  });

  it("uses the custom value only for the custom id", () => {
    expect(densityFor(CUSTOM_MATERIAL_ID, 2.5)).toBeCloseTo(2.5);
  });

  it("falls back to the first preset for an unrecognised id", () => {
    expect(densityFor("unobtainium", 99)).toBeCloseTo(MATERIAL_PRESETS[0]!.density);
  });
});

describe("estimateEffectiveVolume", () => {
  it("is exactly the solid volume at 100% infill, shell/area irrelevant", () => {
    expect(estimateEffectiveVolume(1000, 600, 100, 0.8)).toBeCloseTo(1000);
  });

  it("is the shell + a fraction of the interior below 100%", () => {
    // area 600mm2, wall 0.8mm -> shell 480mm3; interior 1000-480=520mm3
    const v = estimateEffectiveVolume(1000, 600, 20, 0.8);
    expect(v).toBeCloseTo(480 + 520 * 0.2);
  });

  it("caps the shell at the whole body, never estimates more than 100%", () => {
    // area 1000mm2, wall 5mm -> naive shell 5000mm3, way over the 200mm3 body
    const v = estimateEffectiveVolume(200, 1000, 0, 5);
    expect(v).toBeCloseTo(200); // 0% infill of a body whose "shell" already covers it
  });

  it("never goes negative on a degenerate body", () => {
    expect(estimateEffectiveVolume(-5, 10, 50, 0.8)).toBeGreaterThanOrEqual(0);
  });
});

describe("filamentLengthMm", () => {
  it("is volume over the filament's cross-section area", () => {
    const d = 1.75;
    const crossSection = Math.PI * (d / 2) ** 2;
    expect(filamentLengthMm(1000, d)).toBeCloseTo(1000 / crossSection);
  });

  it("a thicker filament needs a shorter length for the same volume", () => {
    expect(filamentLengthMm(1000, 2.85)).toBeLessThan(filamentLengthMm(1000, 1.75));
  });
});

describe("estimateFilament", () => {
  it("masses a 10mm PLA cube (1000mm3) at 1.24g, 100% infill", () => {
    const est = estimateFilament({
      volumeMm3: 1000, areaMm2: 600, densityGPerCm3: 1.24,
      infillPct: 100, wallThicknessMm: 0.8, filamentDiameterMm: 1.75,
    });
    expect(est.massG).toBeCloseTo(1.24, 6);
    expect(est.effectiveVolumeMm3).toBeCloseTo(1000);
  });

  it("reports both grams and metres, metres = mm length / 1000", () => {
    const est = estimateFilament({
      volumeMm3: 1000, areaMm2: 600, densityGPerCm3: 1.24,
      infillPct: 100, wallThicknessMm: 0.8, filamentDiameterMm: 1.75,
    });
    expect(est.lengthM).toBeCloseTo(est.lengthMm / 1000);
    expect(est.lengthM).toBeGreaterThan(0.4);
    expect(est.lengthM).toBeLessThan(0.5);
  });

  it("a lower infill masses less than a higher one, same body", () => {
    const low = estimateFilament({
      volumeMm3: 8000, areaMm2: 2400, densityGPerCm3: 1.24,
      infillPct: 10, wallThicknessMm: 0.8, filamentDiameterMm: 1.75,
    });
    const high = estimateFilament({
      volumeMm3: 8000, areaMm2: 2400, densityGPerCm3: 1.24,
      infillPct: 90, wallThicknessMm: 0.8, filamentDiameterMm: 1.75,
    });
    expect(low.massG).toBeLessThan(high.massG);
  });
});
