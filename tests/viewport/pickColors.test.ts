import { describe, expect, it } from "vitest";
import {
  MIN_CONTRAST,
  PICK_ALPHA,
  composite,
  contrastRatio,
  oklch,
  pickColor,
  type PickKind,
} from "../../src/viewport/pickColors";

const ACCENTS = {
  light: 0xece6ff,
  lavender: 0x8f7fe8,
  mid: 0x51d6a8,
  dark: 0x140a2a,
  navy: 0x25669b,
};
const BODIES = { white: 0xf4f4f4, light: 0xd8dde3, base: 0x9aa7b4, dark: 0x2a2d33, black: 0x080808 };

function seen(accent: number, body: number, kind: PickKind, part: "face" | "edge") {
  const alpha = PICK_ALPHA[part][kind];
  return contrastRatio(composite(body, pickColor(accent, body, kind, part), alpha), body);
}

describe("the pick colour rule", () => {
  it("measures WCAG contrast", () => {
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
    expect(contrastRatio(0x777777, 0x777777)).toBeCloseTo(1, 5);
  });

  for (const [an, accent] of Object.entries(ACCENTS)) {
    for (const [bn, body] of Object.entries(BODIES)) {
      it(`a ${an} accent on a ${bn} body clears the floor, select above hover`, () => {
        for (const part of ["face", "edge"] as const) {
          const sel = seen(accent, body, "select", part);
          const hov = seen(accent, body, "hover", part);
          expect(sel).toBeGreaterThanOrEqual(MIN_CONTRAST.select);
          expect(hov).toBeGreaterThanOrEqual(MIN_CONTRAST.hover);
          expect(sel).toBeGreaterThan(hov);
        }
      });
    }
  }

  it("holds across every grey, through the lightness where the shift flips direction", () => {
    for (const accent of Object.values(ACCENTS)) {
      const below: number[] = [];
      for (let g = 0; g <= 255; g += 3) {
        const body = (g << 16) | (g << 8) | g;
        expect(seen(accent, body, "select", "face")).toBeGreaterThanOrEqual(MIN_CONTRAST.select);
        expect(seen(accent, body, "hover", "face")).toBeGreaterThanOrEqual(MIN_CONTRAST.hover);
        below.push(oklch(pickColor(accent, body, "select", "face"))[0] < oklch(body)[0] ? 1 : 0);
      }
      // a dark pick on light bodies and a light one on dark bodies, so the flip is inside the sweep
      expect(below[0]).toBe(0);
      expect(below[below.length - 1]).toBe(1);
    }
  });

  it("a selected edge reads against both its body and the ground behind its silhouette", () => {
    for (const accent of Object.values(ACCENTS)) {
      for (const body of Object.values(BODIES)) {
        for (const ground of [0x0b0912, 0xeee8d5]) {
          const c = pickColor(accent, [body, ground], "select", "edge");
          const worst = Math.min(contrastRatio(c, body), contrastRatio(c, ground));
          // a light body on a dark ground leaves no colour 3:1 from both, the best is the middle
          const best = Math.sqrt(contrastRatio(body, ground));
          expect(worst).toBeGreaterThanOrEqual(Math.min(MIN_CONTRAST.select, best * 0.95));
        }
      }
    }
  });

  it("keeps the accent's hue", () => {
    for (const accent of [ACCENTS.lavender, ACCENTS.mid, ACCENTS.navy, 0xff4d6d, 0xff8a3d]) {
      for (const body of Object.values(BODIES)) {
        const h = oklch(pickColor(accent, body, "select", "face"))[2];
        const d = Math.abs(((h - oklch(accent)[2] + 540) % 360) - 180);
        expect(d).toBeLessThan(20);
      }
    }
  });

  it("keeps the accent itself when it already reads", () => {
    expect(pickColor(0x51d6a8, 0x080808, "select", "edge")).toBe(0x51d6a8);
  });

  it("raises a washed out accent's chroma so the pick is not a grey step", () => {
    const c = oklch(pickColor(ACCENTS.light, BODIES.base, "select", "face"))[1];
    expect(c).toBeGreaterThan(0.08);
  });
});
