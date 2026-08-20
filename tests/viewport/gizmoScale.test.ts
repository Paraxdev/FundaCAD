// How big a glyph drawn into the 3D scene is allowed to be.
//
// The rule used to live inside manipulator.handleScale and apply to the handles
// only. The origin arrows were modelled in millimetres and obeyed nothing: 20mm
// arms measured 1253px end to end on a fitted 6mm block, and 82,320px at the
// bottom of the zoom range. These pin the shared rule both glyphs now use.

import { describe, expect, it } from "vitest";
import {
  GLYPH_MODEL_FRACTION,
  glyphScale,
  glyphWorldScale,
} from "../../src/viewport/gizmoScale";

describe("glyphScale", () => {
  it("leaves the pixel size alone while the model is the bigger of the two", () => {
    // The ordinary case, and the cap has to be invisible in it: a 100mm part
    // across 900px carries a 45px handle or an 88px triad without either coming
    // near a fraction of the model.
    expect(glyphScale(45, 100, 100 / 900, 0.45)).toBe(1);
    expect(glyphScale(88, 100, 100 / 900, 0.3)).toBe(1);
  });

  it("shrinks a glyph that would dwarf the part", () => {
    const modelPx = 120;
    const s = glyphScale(88, 10, 10 / modelPx, 0.3);
    expect(s).toBeLessThan(1);
    expect(s * 88).toBeLessThanOrEqual(modelPx * GLYPH_MODEL_FRACTION + 1e-9);
  });

  it("stops at the caller's floor", () => {
    // What counts as too small depends on what the glyph is for, which is why
    // the floor is an argument: a handle has to stay big enough to hit, a marker
    // only big enough to see.
    expect(glyphScale(45, 1, 1 / 4, 0.45)).toBe(0.45);
    expect(glyphScale(88, 1, 1 / 4, 0.3)).toBe(0.3);
  });

  it("falls back to the pixel size when there is nothing to measure against", () => {
    // An empty document has no model diagonal, and the arrows still have to be
    // drawn at a sensible size, because that is the one moment they are the only
    // thing on screen.
    expect(glyphScale(88, null, 0.1, 0.3)).toBe(1);
    expect(glyphScale(88, 100, null, 0.3)).toBe(1);
    expect(glyphScale(88, 0, 0.1, 0.3)).toBe(1);
    expect(glyphScale(88, NaN, 0.1, 0.3)).toBe(1);
    expect(glyphScale(0, 100, 0.1, 0.3)).toBe(1);
  });

  it("never returns zero or a non-finite scale", () => {
    // setScalar(0) collapses a glyph and any invisible grab volume with it,
    // which is indistinguishable from the thing being broken.
    for (const d of [null, 0, -5, 1e-9, 1e9, NaN, Infinity]) {
      for (const p of [null, 0, -1, 1e-9, 1e9, NaN, Infinity]) {
        const s = glyphScale(88, d as number | null, p as number | null, 0.3);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThan(0);
      }
    }
  });

  it("is monotone in how much of the screen the model occupies", () => {
    // A glyph that grew as you zoomed out, or jumped mid-orbit, would read as
    // flicker rather than as a rule.
    let prev = 0;
    for (const modelPx of [10, 40, 80, 160, 400, 1200]) {
      const s = glyphScale(88, 50, 50 / modelPx, 0.3);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
  });
});

describe("glyphWorldScale", () => {
  it("turns one glyph unit into one screen pixel", () => {
    // The whole point: the arrows are modelled in pixels, so 88 units becomes
    // 88 pixels whatever the zoom. This is the assertion the report was about.
    for (const px of [0.5, 0.016, 0.00024]) {
      const world = glyphWorldScale(88, 200, px, 0.3);
      expect(world * 88 / px).toBeCloseTo(88, 6);
    }
  });

  it("carries the cap through", () => {
    const modelPx = 100;
    const px = 10 / modelPx;
    expect(glyphWorldScale(88, 10, px, 0.3)).toBeCloseTo(px * glyphScale(88, 10, px, 0.3), 12);
  });

  it("gives no size at all for a pixel size it cannot use", () => {
    // Rather than a guessed default. A glyph drawn at the wrong scale in a 3D
    // scene is worse than one not drawn: it is indistinguishable from geometry,
    // which is exactly how 20mm arrows read as a girder through the part.
    expect(glyphWorldScale(88, 100, null, 0.3)).toBe(0);
    expect(glyphWorldScale(88, 100, 0, 0.3)).toBe(0);
    expect(glyphWorldScale(88, 100, NaN, 0.3)).toBe(0);
  });
});
