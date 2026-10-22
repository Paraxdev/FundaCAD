// The layer relief runs as three twins (this TS one, the GLSL string and the
// tracer's), so every number they must agree on is pinned in one fixture, written
// by a separate implementation of the same formulas.

import { describe, expect, it } from "vitest";
import {
  RELIEF,
  RELIEF_GLSL,
  reliefAlbedo,
  reliefFade,
  reliefHash,
  reliefRoughness,
  reliefSeam,
  reliefSigma2,
  reliefTilt,
  reliefTread,
  reliefVariance,
  glslFloat,
} from "../../src/viewport/relief";

interface Row {
  f: number;
  c: number;
  depth: number;
  w: number;
  tilt: number;
  tread: number;
  seam: number;
  fade: number;
  sigma2: number;
  roughness: number;
  albedo: number;
}
const fixture = Object.values(
  import.meta.glob("../fixtures/relief_profile.json", { import: "default", eager: true }),
)[0] as {
  constants: Record<string, number>;
  variance: Record<string, number>;
  hash: { k: number; h: number }[];
  rows: Row[];
};

describe("relief profile against the fixture", () => {
  it("has the fixture's constants", () => {
    for (const [k, v] of Object.entries(fixture.constants))
      expect(RELIEF[k as keyof typeof RELIEF], k).toBeCloseTo(v, 12);
  });

  it("gives every row's numbers", () => {
    for (const r of fixture.rows) {
      const at = JSON.stringify({ f: r.f, c: r.c, depth: r.depth, w: r.w });
      expect(reliefTread(r.c), at).toBeCloseTo(r.tread, 9);
      expect(reliefSeam(r.f), at).toBeCloseTo(r.seam, 9);
      expect(reliefFade(r.w), at).toBeCloseTo(r.fade, 9);
      expect(reliefTilt(r.f, r.c, r.depth, r.w), at).toBeCloseTo(r.tilt, 9);
      expect(reliefSigma2(r.c, r.depth), at).toBeCloseTo(r.sigma2, 9);
      expect(reliefRoughness(0.5, r.c, r.depth, r.w), at).toBeCloseTo(r.roughness, 9);
      expect(reliefAlbedo(r.f, 7, r.c, r.w, 0.2, 0.5), at).toBeCloseTo(r.albedo, 9);
    }
  });

  it("gives the fixture's variance and layer hash", () => {
    for (const [d, v] of Object.entries(fixture.variance)) expect(reliefVariance(Number(d))).toBeCloseTo(v, 12);
    for (const { k, h } of fixture.hash) expect(reliefHash(k), String(k)).toBe(h);
  });
});

describe("relief shape", () => {
  it("leaves a flat top untouched and a far wall smooth", () => {
    for (const f of [0.1, 0.5, 0.9]) {
      expect(reliefTilt(f, 1, 0.35, 0.1)).toBeCloseTo(0, 9);
      expect(reliefAlbedo(f, 3, 1, 0.1, 0, 0.5)).toBe(1);
      expect(Math.abs(reliefTilt(f, 0, 0.35, 2))).toBe(0);
    }
    expect(reliefRoughness(0.5, 1, 0.35, 2)).toBeCloseTo(0.5, 9);
  });

  it("keeps a wall's mean albedo from near to far", () => {
    const mean = (w: number) => {
      let s = 0;
      for (let i = 0; i < 1000; i++) s += reliefAlbedo((i + 0.5) / 1000, 0, 0, w, 0, 0.5);
      return s / 1000;
    };
    expect(mean(2) / mean(0.1)).toBeCloseTo(1, 3);
  });
});

describe("relief GLSL", () => {
  it("is generated from the same constants", () => {
    for (const k of ["uClamp", "depthScale", "fadeLo", "fadeHi", "seamWidth", "seamMean"] as const) {
      expect(RELIEF_GLSL.common, k).toContain(glslFloat(RELIEF[k]));
    }
    expect(RELIEF_GLSL.common).toContain("0x7feb352du");
    expect(RELIEF_GLSL.common).toContain("0x846ca68bu");
  });

  it("names no value of a relief in its source, so a setting change never recompiles", () => {
    const src = Object.values(RELIEF_GLSL).join("\n");
    expect(src).toContain("uReliefPitch");
    expect(src).toContain("uReliefDepth");
    expect(src).not.toMatch(/nonPerturbedNormal\s*=/);
  });
});
