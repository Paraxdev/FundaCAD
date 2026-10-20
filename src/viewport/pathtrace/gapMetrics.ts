// How far the realtime view is from the path traced one, as numbers. No imports,
// so vitest and an e2e script that injects the compiled source read the same
// code. Both images are 8 bit sRGB RGBA, the mask is one byte per pixel and
// pixels with a zero byte are left out of every number and drawn clear in the
// heat map. The SSIM windows are weighted by the mask too, so a masked out pixel
// never reaches a masked in score. It is an offline check, about 300 ms and 160 MB
// at 1080p, not something to run per frame.

export interface GapImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, row 0 first. */
  data: ArrayLike<number>;
}

export interface GapMetrics {
  /** Pixels the mask kept. */
  pixels: number;
  /** Mean CIE76 colour difference over the masked pixels. */
  deltaE: number;
  /** Mean luminance SSIM over the masked pixels, 1 for identical images. */
  ssim: number;
  /** Mean linear luminance of a over that of b, 1 when they carry equal light, Infinity when only a does. */
  lumaRatio: number;
  /** RGBA, the per pixel colour difference on a blue to red ramp. */
  heat: Uint8ClampedArray;
}

/** A colour difference of this much is drawn full red in the heat map. */
export const HEAT_FULL_DELTA_E = 20;
/** SSIM window radius, so 7x7 pixels, clipped at the image border. */
const SSIM_RADIUS = 3;
const K1 = 0.01;
const K2 = 0.03;

const D65 = [0.95047, 1, 1.08883] as const;

const toLinearTable = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinearTable[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toLinear(v: number): number {
  return toLinearTable[Math.min(255, Math.max(0, Math.round(v)))]!;
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

function lab(d: ArrayLike<number>, i: number, out: Float64Array): void {
  const lr = toLinear(d[i]!);
  const lg = toLinear(d[i + 1]!);
  const lb = toLinear(d[i + 2]!);
  const fx = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65[0]);
  const fy = labF(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = labF((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / D65[2]);
  out.set([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]);
}

/** Rec. 709 luma of the encoded values, the 0 to 255 signal SSIM is defined on. */
function luma(d: ArrayLike<number>, i: number): number {
  return 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
}

function linearLuma(d: ArrayLike<number>, i: number): number {
  return 0.2126 * toLinear(d[i]!) + 0.7152 * toLinear(d[i + 1]!) + 0.0722 * toLinear(d[i + 2]!);
}

function ramp(t: number, out: Uint8ClampedArray, at: number): void {
  const x = Math.min(1, Math.max(0, t));
  out[at] = 255 * Math.min(1, 2 * x);
  out[at + 1] = 255 * (1 - Math.abs(2 * x - 1)) * 0.9;
  out[at + 2] = 255 * Math.min(1, 2 * (1 - x));
  out[at + 3] = 255;
}

/** Summed area table with a zero row and column in front. */
function integral(values: Float64Array, w: number, h: number): Float64Array {
  const stride = w + 1;
  const sat = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += values[y * w + x]!;
      sat[(y + 1) * stride + x + 1] = sat[y * stride + x + 1]! + row;
    }
  }
  return sat;
}

function windowSum(sat: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const s = w + 1;
  return sat[y1 * s + x1]! - sat[y0 * s + x1]! - sat[y1 * s + x0]! + sat[y0 * s + x0]!;
}

export function gapMetrics(a: GapImage, b: GapImage, mask?: ArrayLike<number>): GapMetrics {
  const { width: w, height: h } = a;
  if (b.width !== w || b.height !== h) throw new Error("the two images differ in size");
  if (a.data.length !== w * h * 4 || b.data.length !== w * h * 4) throw new Error("the buffer is not width x height RGBA");
  if (mask && mask.length !== w * h) throw new Error("the mask is not width x height");
  const n = w * h;

  const la = new Float64Array(n);
  const lb = new Float64Array(n);
  const aa = new Float64Array(n);
  const bb = new Float64Array(n);
  const ab = new Float64Array(n);
  const wt = new Float64Array(n);
  const labA = new Float64Array(3);
  const labB = new Float64Array(3);
  const heat = new Uint8ClampedArray(n * 4);
  let pixels = 0;
  let sumDelta = 0;
  let sumLinA = 0;
  let sumLinB = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (mask && !mask[p]) continue;
    const ya = luma(a.data, i);
    const yb = luma(b.data, i);
    wt[p] = 1;
    la[p] = ya;
    lb[p] = yb;
    aa[p] = ya * ya;
    bb[p] = yb * yb;
    ab[p] = ya * yb;
    lab(a.data, i, labA);
    lab(b.data, i, labB);
    const delta = Math.hypot(labA[0]! - labB[0]!, labA[1]! - labB[1]!, labA[2]! - labB[2]!);
    ramp(delta / HEAT_FULL_DELTA_E, heat, i);
    pixels++;
    sumDelta += delta;
    sumLinA += linearLuma(a.data, i);
    sumLinB += linearLuma(b.data, i);
  }

  const sa = integral(la, w, h);
  const sb = integral(lb, w, h);
  const saa = integral(aa, w, h);
  const sbb = integral(bb, w, h);
  const sab = integral(ab, w, h);
  const swt = integral(wt, w, h);

  const c1 = (K1 * 255) ** 2;
  const c2 = (K2 * 255) ** 2;
  let sumSsim = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - SSIM_RADIUS);
    const y1 = Math.min(h, y + SSIM_RADIUS + 1);
    for (let x = 0; x < w; x++) {
      if (mask && !mask[y * w + x]) continue;
      const x0 = Math.max(0, x - SSIM_RADIUS);
      const x1 = Math.min(w, x + SSIM_RADIUS + 1);
      const count = windowSum(swt, w, x0, y0, x1, y1);
      const ma = windowSum(sa, w, x0, y0, x1, y1) / count;
      const mb = windowSum(sb, w, x0, y0, x1, y1) / count;
      const va = Math.max(0, windowSum(saa, w, x0, y0, x1, y1) / count - ma * ma);
      const vb = Math.max(0, windowSum(sbb, w, x0, y0, x1, y1) / count - mb * mb);
      const cov = windowSum(sab, w, x0, y0, x1, y1) / count - ma * mb;
      sumSsim += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
    }
  }

  return {
    pixels,
    deltaE: pixels ? sumDelta / pixels : NaN,
    ssim: pixels ? sumSsim / pixels : NaN,
    lumaRatio: !pixels ? NaN : sumLinA === sumLinB ? 1 : sumLinA / sumLinB,
    heat,
  };
}
