import { describe, expect, it } from "vitest";
import { gapMetrics, HEAT_FULL_DELTA_E, type GapImage } from "../../src/viewport/pathtrace/gapMetrics";

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): GapImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const pattern = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) % 256, (x * 5 + y * 71) % 256, (x * 13 + y * 29) % 256];
const flat = (v: number) => (): [number, number, number] => [v, v, v];
const stripes = (alongX: boolean) => (x: number, y: number): [number, number, number] => ((alongX ? x : y) % 2 ? [255, 255, 255] : [0, 0, 0]);

describe("gapMetrics", () => {
  it("scores identical images as no difference and full similarity", () => {
    const m = gapMetrics(image(16, 12, pattern), image(16, 12, pattern));
    expect(m.deltaE).toBe(0);
    expect(m.ssim).toBeCloseTo(1, 12);
    expect(m.lumaRatio).toBeCloseTo(1, 12);
    expect(m.pixels).toBe(16 * 12);
  });

  it("measures white against black as the Lab lightness span", () => {
    const m = gapMetrics(image(8, 8, flat(255)), image(8, 8, flat(0)));
    expect(m.deltaE).toBeCloseTo(100, 4);
    expect(m.lumaRatio).toBe(Infinity);
  });

  it("matches the CIE76 value of one known pair", () => {
    // sRGB red is Lab (53.2408, 80.0925, 67.2032), black is (0, 0, 0).
    const m = gapMetrics(image(4, 4, () => [255, 0, 0]), image(4, 4, flat(0)));
    expect(m.deltaE).toBeCloseTo(Math.hypot(53.2408, 80.0925, 67.2032), 2);
  });

  it("reads a flat brightness shift as the SSIM luminance term", () => {
    const m = gapMetrics(image(16, 16, flat(100)), image(16, 16, flat(150)));
    const c1 = (0.01 * 255) ** 2;
    expect(m.ssim).toBeCloseTo((2 * 100 * 150 + c1) / (100 * 100 + 150 * 150 + c1), 9);
  });

  it("gives the ratio of linear light, not of the encoded values", () => {
    const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
    const m = gapMetrics(image(8, 8, flat(200)), image(8, 8, flat(100)));
    expect(m.lumaRatio).toBeCloseTo(lin(200) / lin(100), 9);
  });

  it("drops a structure that is uncorrelated with the other image", () => {
    const m = gapMetrics(image(32, 32, stripes(true)), image(32, 32, stripes(false)));
    expect(m.ssim).toBeLessThan(0.2);
  });

  it("leaves masked out pixels out of every number and clears them in the heat map", () => {
    const a = image(8, 8, (x) => (x < 4 ? [90, 90, 90] : [255, 0, 0]));
    const b = image(8, 8, flat(90));
    const mask = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) mask[y * 8 + x] = 1;
    const m = gapMetrics(a, b, mask);
    expect(m.pixels).toBe(32);
    expect(m.deltaE).toBe(0);
    expect(m.lumaRatio).toBeCloseTo(1, 12);
    expect(m.heat[6 * 4 + 3]).toBe(0);
    expect(m.heat[1 * 4 + 3]).toBe(255);
    expect(gapMetrics(a, b).deltaE).toBeGreaterThan(10);
  });

  it("reports nothing measurable for an empty mask", () => {
    const a = image(4, 4, pattern);
    const m = gapMetrics(a, a, new Uint8Array(16));
    expect(m.pixels).toBe(0);
    expect(m.deltaE).toBeNaN();
  });

  it("draws the heat map from blue at no difference to red at the full scale", () => {
    const a = image(2, 1, (x) => (x === 0 ? [50, 50, 50] : [255, 255, 255]));
    const b = image(2, 1, (x) => (x === 0 ? [50, 50, 50] : [0, 0, 0]));
    const { heat } = gapMetrics(a, b);
    expect([heat[0], heat[2]]).toEqual([0, 255]);
    expect([heat[4], heat[6]]).toEqual([255, 0]);
    expect(HEAT_FULL_DELTA_E).toBeLessThan(100);
  });

  it("refuses images of different size and a mask of the wrong length", () => {
    expect(() => gapMetrics(image(2, 2, pattern), image(3, 2, pattern))).toThrow();
    expect(() => gapMetrics(image(2, 2, pattern), image(2, 2, pattern), new Uint8Array(3))).toThrow();
  });
});
