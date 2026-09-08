// The Texture panel's conditional rows are the part of it worth pinning: they
// encode sidecar behaviour rather than taste, and one of the rules here exists
// because the opposite of it was a bug, Direction used to be gated behind
// ANGLE_KINDS, which left the noise/voronoi/image kinds able only to GROW the
// part instead of texturing the surface it sits on.

import { describe, it, expect } from "vitest";
import {
  ANGLE_KINDS, SEED_KINDS, basename, initialTextureForm, sharpnessLabel, textureRows, toTextureValues,
} from "../../plugins/FundaCAD.Texture/textureForm";

describe("textureRows", () => {
  it("shows the lattice orientation only for the lattice/wave kinds", () => {
    for (const k of ["knurl", "hex", "waves", "ribs"] as const) {
      expect(textureRows({ kind: k, profile: "round" }).angle).toBe(true);
    }
    for (const k of ["voronoi", "noise", "image"] as const) {
      expect(textureRows({ kind: k, profile: "round" }).angle).toBe(false);
    }
  });

  it("swaps the orientation for a seed on the random kinds", () => {
    expect(textureRows({ kind: "voronoi", profile: "facet" }).seed).toBe(true);
    expect(textureRows({ kind: "noise", profile: "facet" }).seed).toBe(true);
    expect(textureRows({ kind: "knurl", profile: "facet" }).seed).toBe(false);
  });

  it("shows the file picker only for the image heightmap", () => {
    expect(textureRows({ kind: "image", profile: "facet" }).image).toBe(true);
    expect(textureRows({ kind: "noise", profile: "facet" }).image).toBe(false);
  });

  // A FACETED wave is a fixed 8-join sine polyline with no shape parameter at
  // all (sidecar `_wave_levels`), so the slider goes away rather than sitting
  // there doing nothing. Under `round` it is a real sine and sharpness crisps it.
  it("drops the sharpness slider for the one combination it means nothing in", () => {
    expect(textureRows({ kind: "waves", profile: "facet" }).sharpness).toBe(false);
    expect(textureRows({ kind: "waves", profile: "round" }).sharpness).toBe(true);
    expect(textureRows({ kind: "knurl", profile: "facet" }).sharpness).toBe(true);
  });

  it("never offers sharpness on a kind that has no angle row to hold it", () => {
    for (const k of ["voronoi", "noise", "image"] as const) {
      expect(textureRows({ kind: k, profile: "round" }).sharpness).toBe(false);
    }
  });

  it("agrees with the sets textureTool.ts trims the feature JSON with", () => {
    for (const k of [...ANGLE_KINDS]) expect(textureRows({ kind: k, profile: "round" }).angle).toBe(true);
    for (const k of [...SEED_KINDS]) expect(textureRows({ kind: k, profile: "round" }).seed).toBe(true);
  });
});

describe("sharpnessLabel", () => {
  it("renames the slider to match what it does under each profile", () => {
    expect(sharpnessLabel("facet").text).toBe("Land");
    expect(sharpnessLabel("round").text).toBe("Sharp");
    expect(sharpnessLabel("facet").title).toContain("V-groove");
  });
});

describe("initialTextureForm / toTextureValues", () => {
  it("defaults to a faceted knurl, what a printer can actually reproduce", () => {
    const v = toTextureValues(initialTextureForm({}));
    expect(v.kind).toBe("knurl");
    expect(v.profile).toBe("facet");
    expect(v.depth).toBe(0.4);
    expect(v.scale).toBe(2);
    expect(v.direction).toBe("out");
  });

  it("omits imagePath and colorSlot rather than sending empty ones", () => {
    const v = toTextureValues(initialTextureForm({}));
    expect("imagePath" in v).toBe(false);
    expect("colorSlot" in v).toBe(false);
  });

  it("keeps palette slot 0, which is falsy and has been dropped before", () => {
    const v = toTextureValues(initialTextureForm({ colorSlot: 0 }));
    expect(v.colorSlot).toBe(0);
  });

  it("clamps a negative edge blend to zero", () => {
    const f = initialTextureForm({});
    expect(toTextureValues({ ...f, edgeBlend: "-3" }).boundaryInset).toBe(0);
  });

  it("falls back instead of emitting NaN from a half-typed field", () => {
    const f = initialTextureForm({});
    const v = toTextureValues({ ...f, depth: "", scale: "", seed: "", sharpness: "" });
    expect(v.depth).toBe(0.4);
    expect(v.scale).toBe(2);
    expect(v.seed).toBe(1);
    expect(v.sharpness).toBe(0);
  });

  it("round-trips an existing texture feature", () => {
    const v = {
      kind: "voronoi", depth: 1.2, scale: 5, angle: 30, offset: 0.1, sharpness: 0.8,
      profile: "round", boundaryInset: 0.25, direction: "both", seed: 7, invert: true,
      imagePath: "C:/x/y.png", colorSlot: 2,
    } as const;
    expect(toTextureValues(initialTextureForm(v))).toEqual(v);
  });
});

describe("basename", () => {
  it("handles both separators, the picker returns native Windows paths", () => {
    expect(basename("C:\\images\\bump.png")).toBe("bump.png");
    expect(basename("/home/u/bump.png")).toBe("bump.png");
    expect(basename("bump.png")).toBe("bump.png");
  });
});
