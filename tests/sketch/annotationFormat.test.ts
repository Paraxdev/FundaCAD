// The dimension/glyph badges are now rendered declaratively, so what a badge
// SAYS and what classes it wears are pure functions, and this is the only layer
// of the two annotation overlays a headless test can reach at all. Where a badge
// sits comes out of a live camera through a rAF loop; happy-dom has no layout
// and no WebGL, so that half stays e2e/manual territory. screenTransform's shape
// is pinned here because it is the one piece of it that is pure.

import { afterEach, describe, it, expect } from "vitest";
import { setLanguage } from "../../src/i18n";
import {
  dimClass,
  dimTitle,
  fmtDim,
  glyphClass,
  glyphTitle,
  isFormula,
  screenTransform,
} from "../../src/sketch/annotationFormat";

describe("fmtDim", () => {
  it("shows a length in the display unit and an angle in degrees", () => {
    expect(fmtDim(40)).toBe("40 mm");
    expect(fmtDim(40, "angle")).toBe("40°");
  });

  it("brackets a driven (reference) dimension", () => {
    expect(fmtDim(40, "length", true)).toBe("(40 mm)");
  });

  it("prefixes a formula-driven dimension with fx:", () => {
    expect(fmtDim(40, "length", false, true)).toBe("fx: 40 mm");
  });

  it("lets driven be preferred over fx, a reference dim is not editable either way", () => {
    expect(fmtDim(40, "length", true, true)).toBe("(40 mm)");
  });
});

describe("isFormula", () => {
  it("is false for a bare literal and for no expression at all", () => {
    expect(isFormula(undefined)).toBe(false);
    expect(isFormula("")).toBe(false);
    expect(isFormula("40")).toBe(false);
    expect(isFormula("-2e3")).toBe(false);
  });

  it("is true for anything the params engine has to evaluate", () => {
    expect(isFormula("width/2")).toBe(true);
    expect(isFormula("5+3")).toBe(true);
  });
});

describe("dimClass", () => {
  it("is the bare badge with no flags", () => {
    expect(dimClass({})).toBe("sketch-dim");
  });

  it("adds one modifier per flag", () => {
    expect(dimClass({ driven: true })).toBe("sketch-dim sketch-dim-driven");
    expect(dimClass({ fx: true })).toBe("sketch-dim sketch-dim-fx");
  });

  // Same precedence as diagnosisOf() in glyphs.ts. If these two ever disagree,
  // a constraint shows red on its glyph and amber on its dimension.
  it("lets conflict be preferred over over-defined", () => {
    expect(dimClass({ conflict: true, over: true })).toBe("sketch-dim conflict");
    expect(dimClass({ over: true })).toBe("sketch-dim over");
  });
});

describe("dimTitle", () => {
  it("says a reference dimension is read-only", () => {
    expect(dimTitle({ driven: true })).toContain("not driving");
  });

  it("shows the expression itself on a formula-driven dim", () => {
    expect(dimTitle({ fx: true, expr: "width/2" })).toBe("= width/2 · click to edit");
  });

  it("shows the formula with the decimal comma in German and a point again in English", async () => {
    await setLanguage("de");
    try {
      expect(dimTitle({ fx: true, expr: "max(width*1.5;2.25)" })).toBe("= max(width*1,5;2,25) · click to edit");
    } finally {
      await setLanguage("system");
    }
    expect(dimTitle({ fx: true, expr: "max(width*1.5;2.25)" })).toBe("= max(width*1.5;2.25) · click to edit");
  });

  it("advertises both gestures on an ordinary dim", () => {
    expect(dimTitle({})).toBe("Click to edit, drag to move");
  });
});

describe("glyph presentation", () => {
  it("names the diagnosis in the class so the stylesheet can colour it", () => {
    expect(glyphClass(null)).toBe("sketch-glyph");
    expect(glyphClass("conflict")).toBe("sketch-glyph conflict");
    expect(glyphClass("over")).toBe("sketch-glyph over");
  });

  it("says a click selects and Delete removes, in every state", () => {
    for (const st of [null, "conflict", "over"] as const) expect(glyphTitle(st)).toMatch(/select.*Delete removes/);
    expect(glyphTitle("conflict")).toContain("Conflicting");
    expect(glyphTitle("over")).toContain("Redundant");
  });
});

describe("screenTransform", () => {
  // The -50% pair has to stay IN the transform: the stylesheet centres the badge
  // with `transform: translate(-50%,-50%)`, and the projected translate would
  // otherwise overwrite the whole property and hang every label off its
  // top-left corner.
  it("centres the badge on the projected point", () => {
    expect(screenTransform(120, 40.5)).toBe("translate(120px, 40.5px) translate(-50%, -50%)");
  });
});

describe("fmtDim in a comma language", () => {
  afterEach(() => setLanguage("system"));

  it("shows a decimal comma in a length and an angle", async () => {
    await setLanguage("de");
    expect([
      fmtDim(12.375),
      fmtDim(37.5, "angle"),
      fmtDim(37.5, "angle", true),
      fmtDim(0.35, "length", false, true),
    ]).toEqual(["12,375 mm", "37,5°", "(37,5°)", "fx: 0,35 mm"]);
  });
});
