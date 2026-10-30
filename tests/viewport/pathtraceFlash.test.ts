import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { analyse, blackEdges, flashesPerSecond, isBand, toGrid } = createRequire(import.meta.url)(
  "../../e2e/lib/flash.cjs",
);

const COLS = 8;
const ROWS = 5;
const plain = (v: number) => new Float32Array(COLS * ROWS).fill(v);
const steps = (values: number[], ms: number) => values.map((v, i) => ({ t: i * ms, lum: plain(v) }));
const alternating = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));

function withBlackBelow(row: number) {
  const lum = plain(0.3);
  lum.fill(0, row * COLS);
  return lum;
}

describe("flash analysis of shown frames", () => {
  it("reads sRGB into relative luminance per cell", () => {
    const rgba = new Uint8Array(4 * 4).fill(255);
    rgba.fill(0, 0, 8);
    const grid = toGrid(rgba, 2, 2, 1, 2);
    expect(grid[0]).toBeCloseTo(0, 5);
    expect(grid[1]).toBeCloseTo(1, 5);
  });

  it("counts a light and dark swing at 8 Hz as eight flashes", () => {
    expect(flashesPerSecond(steps(alternating(40, 0.1, 0.6), 62.5))).toBe(8);
  });

  it("passes three flashes a second and fails three and a half", () => {
    const at = (changes: number) => {
      const v: number[] = [];
      for (let i = 0; i <= changes; i++) v.push(i % 2 ? 0.6 : 0.1);
      return steps(v, 1000 / (changes + 1));
    };
    expect(flashesPerSecond(at(6))).toBeLessThanOrEqual(3);
    expect(flashesPerSecond(at(7))).toBeGreaterThan(3);
  });

  it("ignores a swing under 10 percent of full luminance", () => {
    expect(flashesPerSecond(steps(alternating(60, 0.2, 0.28), 16))).toBe(0);
  });

  it("ignores a swing where the darker image is above 0.80", () => {
    expect(flashesPerSecond(steps(alternating(60, 0.82, 0.98), 16))).toBe(0);
  });

  it("ignores a flash over less than a quarter of the frame", () => {
    const frames = alternating(60, 0, 1).map((v, i) => {
      const lum = plain(0.3);
      lum.fill(v, 0, COLS);
      return { t: i * 16, lum };
    });
    expect(flashesPerSecond(frames)).toBe(0);
  });

  it("counts a slow fade up and down as one flash", () => {
    const ramp = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1];
    expect(flashesPerSecond(steps(ramp, 40))).toBe(1);
  });

  it("finds the black rows below a partial frame", () => {
    expect(blackEdges(withBlackBelow(2), COLS)).toMatchObject({ top: 0, bottom: 3 });
    expect(isBand(withBlackBelow(2), COLS)).toBe(true);
    expect(isBand(plain(0.3), COLS)).toBe(false);
    expect(isBand(plain(0), COLS)).toBe(false);
  });

  it("flags a lit frame going black and a partial frame, and passes a steady run", () => {
    const steady = analyse(steps([0.3, 0.3, 0.31, 0.3], 16), COLS);
    expect(steady).toMatchObject({ bands: 0, blackFrames: 0, overLimit: false });
    const black = analyse(steps([0.3, 0, 0.3], 16), COLS);
    expect(black.blackFrames).toBe(1);
    const band = analyse(
      [
        { t: 0, lum: plain(0.3) },
        { t: 16, lum: withBlackBelow(2) },
      ],
      COLS,
    );
    expect(band.bands).toBe(1);
    expect(band.bad[0]).toMatchObject({ i: 1, band: true });
  });
});
