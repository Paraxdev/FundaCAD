import { describe, expect, it } from "vitest";
import { atrousCpu, atrousSigma, filterMix, type AtrousImage } from "../../src/viewport/pathtrace/atrous";

function image(w: number, h: number, at: (x: number, y: number) => { c: number; n: [number, number, number]; z: number; a?: number }): AtrousImage {
  const img: AtrousImage = {
    width: w, height: h,
    color: new Float32Array(w * h * 3), albedo: new Float32Array(w * h * 3),
    normal: new Float32Array(w * h * 3), depth: new Float32Array(w * h),
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    const v = at(x, y);
    img.color.fill(v.c, p * 3, p * 3 + 3);
    img.albedo.fill(v.a ?? 0.5, p * 3, p * 3 + 3);
    img.normal.set(v.n, p * 3);
    img.depth[p] = v.z;
  }
  return img;
}

let seed = 7;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);

function spread(out: Float32Array, pick: (p: number) => boolean): number {
  const v: number[] = [];
  for (let p = 0; p < out.length / 3; p++) if (pick(p)) v.push(out[p * 3]!);
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

describe("a-trous filter", () => {
  it("smooths noise on a flat face", () => {
    const img = image(32, 32, () => ({ c: 0.4 + 0.1 * noise(), n: [0, 0, 1], z: 10 }));
    const before = spread(img.color, () => true);
    const after = spread(atrousCpu(img, 4), () => true);
    expect(after).toBeLessThan(before / 3);
  });

  it("keeps a crease where the normal turns, and a step in depth", () => {
    const crease = image(32, 16, (x) => (x < 16 ? { c: 0.2, n: [0, 0, 1], z: 10 } : { c: 0.8, n: [1, 0, 0], z: 10 }));
    const a = atrousCpu(crease, 1);
    expect(a[(8 * 32 + 15) * 3]).toBeCloseTo(0.2, 3);
    expect(a[(8 * 32 + 16) * 3]).toBeCloseTo(0.8, 3);
    const step = image(32, 16, (x) => (x < 16 ? { c: 0.2, n: [0, 0, 1], z: 10 } : { c: 0.8, n: [0, 0, 1], z: 30 }));
    const b = atrousCpu(step, 1);
    expect(b[(8 * 32 + 15) * 3]).toBeCloseTo(0.2, 3);
    expect(b[(8 * 32 + 16) * 3]).toBeCloseTo(0.8, 3);
  });

  it("keeps a painted edge on one face, the albedo carries it", () => {
    const img = image(32, 16, (x) => ({ c: x < 16 ? 0.1 : 0.7, a: x < 16 ? 0.1 : 0.7, n: [0, 0, 1], z: 10 }));
    const out = atrousCpu(img, 1);
    expect(out[(8 * 32 + 15) * 3]).toBeCloseTo(0.1, 3);
    expect(out[(8 * 32 + 16) * 3]).toBeCloseTo(0.7, 3);
  });

  it("keeps the traced mix on a silhouette instead of growing the body over it", () => {
    // The raster guide says body from x = 16, the trace covered half of that column.
    const img = image(32, 16, (x) => (x < 16 ? { c: 0, n: [0, 0, 1], z: 0, a: 0 } : { c: x === 16 ? 0.25 : 0.5 + 0.1 * noise(), n: [0, 0, 1], z: 10 }));
    const out = atrousCpu(img, 4);
    expect(out[(8 * 32 + 16) * 3]).toBeCloseTo(0.25, 3);
    expect(out[(8 * 32 + 15) * 3]).toBe(0);
    expect(spread(out, (p) => p % 32 >= 18)).toBeLessThan(spread(img.color, (p) => p % 32 >= 18) / 3);
  });

  it("leaves the background alone", () => {
    const img = image(8, 8, (x, y) => ({ c: (x + y) / 16, n: [0, 0, 1], z: 0 }));
    expect(Array.from(atrousCpu(img, 1))).toEqual(Array.from(img.color));
  });

  it("shrinks its luminance stop as 1/sqrt(spp) and fades out by the cap", () => {
    expect(atrousSigma(4) / atrousSigma(16)).toBeCloseTo(2);
    expect(filterMix(1, 256)).toBe(1);
    expect(filterMix(16, 256)).toBe(1);
    expect(filterMix(64, 256)).toBeCloseTo(0.5);
    expect(filterMix(256, 256)).toBe(0);
  });
});
