// An imported HDR panorama as plain pixels: decode, refuse, downscale, encode.
// No WebGL and no DOM, so the headless suite reaches all of it.

import * as THREE from "three";
import { unzlibSync, zlibSync } from "three/examples/jsm/libs/fflate.module.js";

/** Linear RGBA floats, row 0 at the top (the sky of an equirect). */
export interface HdrImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Kept and embedded at this width; lighting reads a quarter of the pixels. */
export const STORED_HDR_WIDTH = 2048;
/** One texel per texel of the 256 cube face the room is rendered into. */
export const LIGHTING_HDR_WIDTH = 1024;
/** The most half float bytes an OpenEXR may unpack to: three's EXRLoader has no streaming path, and past this a
 *  typed array is refused or the window runs out of memory. */
export const MAX_EXR_DECODE_BYTES = 2 ** 31;

export class HdrRefusal extends Error {}

export function isHdrName(name: string): boolean {
  return /\.(hdr|exr)$/i.test(name);
}

/** The size a Radiance header declares, or null when it is not one. */
export function radianceSize(bytes: Uint8Array): { width: number; height: number } | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (!head.startsWith("#?")) return null;
  const m = /\n\s*([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)\s*\n/.exec(head);
  return m ? { width: Number(m[4]), height: Number(m[2]) } : null;
}

/** The size an OpenEXR header's dataWindow declares, or null when it is not one. */
export function exrSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 8 || bytes[0] !== 0x76 || bytes[1] !== 0x2f || bytes[2] !== 0x31 || bytes[3] !== 0x01) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cstr = (at: number) => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return end < bytes.length
      ? { text: new TextDecoder("latin1").decode(bytes.subarray(at, end)), next: end + 1 }
      : null;
  };
  let p = 8;
  while (p < bytes.length && bytes[p] !== 0) {
    const name = cstr(p);
    const type = name && cstr(name.next);
    if (!name || !type || type.next + 4 > bytes.length) return null;
    const size = view.getInt32(type.next, true);
    const body = type.next + 4;
    if (size < 0 || body + size > bytes.length) return null;
    if (name.text === "dataWindow" && type.text === "box2i" && size === 16) {
      const [x0, y0, x1, y1] = [0, 4, 8, 12].map((o) => view.getInt32(body + o, true)) as [
        number,
        number,
        number,
        number,
      ];
      return { width: x1 - x0 + 1, height: y1 - y0 + 1 };
    }
    p = body + size;
  }
  return null;
}

/** Rows reversed in place; three's EXRLoader hands them back bottom first. */
function flipRows(data: Float32Array, width: number, height: number) {
  const stride = width * 4;
  const tmp = new Float32Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    tmp.set(data.subarray(top * stride, top * stride + stride));
    data.copyWithin(top * stride, bottom * stride, bottom * stride + stride);
    data.set(tmp, bottom * stride);
  }
}

function refuseEmpty(name: string, width: number, height: number) {
  if (width < 2 || height < 1) throw new HdrRefusal(`${name} has no pixels.`);
}

/** The halving a `width` panorama needs to fit `maxWidth`, a power of two, so the result matches downscaleEquirect. */
export function shrinkFactor(width: number, maxWidth: number): number {
  let f = 1;
  while (Math.floor(width / f) > maxWidth) f *= 2;
  return f;
}

/** 2^(e - 136): a mantissa m decodes to (m + 0.5) times it, the Radiance convention, which encodeRgbe inverts. */
const RGBE_SCALE = Float32Array.from({ length: 256 }, (_, e) => (e === 0 ? 0 : 2 ** (e - 136)));

/** Averages `f` x `f` blocks of a source fed a row at a time, the edge rows and columns that do not fill a block
 *  folded into the last one. */
class BoxShrink {
  readonly width: number;
  readonly height: number;
  private readonly data: Float32Array;
  private readonly cols: Float32Array;
  private readonly rows: Float32Array;
  /** Each source column's offset into an output row. */
  private readonly at: Int32Array;
  constructor(
    srcWidth: number,
    srcHeight: number,
    private readonly f: number,
  ) {
    this.width = Math.max(1, Math.floor(srcWidth / f));
    this.height = Math.max(1, Math.floor(srcHeight / f));
    this.data = new Float32Array(this.width * this.height * 4);
    this.cols = new Float32Array(this.width);
    this.rows = new Float32Array(this.height);
    for (let x = 0; x < srcWidth; x++) this.cols[this.col(x)] = this.cols[this.col(x)]! + 1;
    for (let y = 0; y < srcHeight; y++) this.rows[this.row(y)] = this.rows[this.row(y)]! + 1;
    this.at = Int32Array.from({ length: srcWidth }, (_, x) => this.col(x) * 4);
  }
  /** One source row of Radiance pixels, RGBE bytes. */
  addRgbeRow(y: number, scan: Uint8Array) {
    const o = this.row(y) * this.width * 4;
    const d = this.data;
    const at = this.at;
    for (let x = 0, n = at.length; x < n; x++) {
      const e = RGBE_SCALE[scan[x * 4 + 3]!]!;
      if (e === 0) continue;
      const i = o + at[x]!;
      d[i] = d[i]! + (scan[x * 4]! + 0.5) * e;
      d[i + 1] = d[i + 1]! + (scan[x * 4 + 1]! + 0.5) * e;
      d[i + 2] = d[i + 2]! + (scan[x * 4 + 2]! + 0.5) * e;
    }
  }
  private col(x: number): number {
    return Math.min(this.width - 1, Math.floor(x / this.f));
  }
  private row(y: number): number {
    return Math.min(this.height - 1, Math.floor(y / this.f));
  }
  /** One source row of RGB floats. */
  addRow(y: number, rgb: Float32Array) {
    const o = this.row(y) * this.width * 4;
    const d = this.data;
    const n = rgb.length / 3;
    for (let x = 0; x < n; x++) {
      const i = o + this.at[x]!;
      d[i] = d[i]! + rgb[x * 3]!;
      d[i + 1] = d[i + 1]! + rgb[x * 3 + 1]!;
      d[i + 2] = d[i + 2]! + rgb[x * 3 + 2]!;
    }
  }
  finish(): HdrImage {
    const d = this.data;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        const k = 1 / (this.rows[y]! * this.cols[x]!);
        d[i] = d[i]! * k;
        d[i + 1] = d[i + 1]! * k;
        d[i + 2] = d[i + 2]! * k;
        d[i + 3] = 1;
      }
    }
    return { width: this.width, height: this.height, data: d };
  }
}

const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0));

/** A Radiance file read one scanline at a time into a box downscale, so a 16k panorama never sits whole in memory
 *  as floats. */
async function decodeRadiance(bytes: Uint8Array, name: string, maxWidth: number): Promise<HdrImage> {
  const notOne = () => new HdrRefusal(`${name} is not a Radiance HDR image.`);
  if (bytes[0] !== 0x23 || bytes[1] !== 0x3f) throw notOne();
  let p = 0;
  const latin = new TextDecoder("latin1");
  const line = () => {
    let end = p;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const text = latin.decode(bytes.subarray(p, end));
    p = end + 1;
    return text;
  };
  for (let n = 0; ; n++) {
    if (p >= bytes.length || n > 1000) throw notOne();
    const text = line();
    if (/^\s*FORMAT=/.test(text) && !/32-bit_rle_rgbe/.test(text)) {
      throw new HdrRefusal(`${name} is a Radiance file in ${text.split("=")[1]}, only RGBE is read.`);
    }
    if (text.trim() === "" && n > 0) break;
  }
  const res = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(line());
  if (!res) throw new HdrRefusal(`${name} is a Radiance file stored turned or flipped, which is not read.`);
  const height = Number(res[1]);
  const width = Number(res[2]);
  refuseEmpty(name, width, height);
  const shrink = new BoxShrink(width, height, shrinkFactor(width, maxWidth));
  const scan = new Uint8Array(width * 4);
  const short = () => new HdrRefusal(`${name} ends before its last scanline.`);
  const broken = () => new HdrRefusal(`${name} has a broken scanline.`);
  let lastYield = performance.now();
  for (let y = 0; y < height; y++) {
    if (p + 4 > bytes.length) throw short();
    const rle = width >= 8 && width < 32768 && bytes[p] === 2 && bytes[p + 1] === 2 && !(bytes[p + 2]! & 0x80);
    if (rle) {
      if (((bytes[p + 2]! << 8) | bytes[p + 3]!) !== width) throw broken();
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          if (p >= bytes.length) throw short();
          let count = bytes[p++]!;
          if (count > 128) {
            count -= 128;
            if (count > width - x || p >= bytes.length) throw broken();
            const v = bytes[p++]!;
            for (let k = 0; k < count; k++) scan[x++ * 4 + c] = v;
          } else {
            if (count === 0 || count > width - x || p + count > bytes.length) throw broken();
            for (let k = 0; k < count; k++) scan[x++ * 4 + c] = bytes[p++]!;
          }
        }
      }
    } else {
      // Flat pixels, with the old run length form: 1, 1, 1, n repeats the pixel before n << shift times.
      let x = 0;
      let shift = 0;
      while (x < width) {
        if (p + 4 > bytes.length) throw short();
        if (bytes[p] === 1 && bytes[p + 1] === 1 && bytes[p + 2] === 1 && x > 0) {
          const n = bytes[p + 3]! << shift;
          p += 4;
          for (let k = 0; k < n && x < width; k++, x++) scan.copyWithin(x * 4, (x - 1) * 4, x * 4);
          shift += 8;
          continue;
        }
        scan.set(bytes.subarray(p, p + 4), x * 4);
        p += 4;
        x++;
        shift = 0;
      }
    }
    shrink.addRgbeRow(y, scan);
    if (performance.now() - lastYield > 50) {
      await yieldToPage();
      lastYield = performance.now();
    }
  }
  return shrink.finish();
}

async function decodeExr(bytes: Uint8Array, name: string, maxWidth: number): Promise<HdrImage> {
  const size = exrSize(bytes);
  if (!size) throw new HdrRefusal(`${name} is not an OpenEXR image.`);
  refuseEmpty(name, size.width, size.height);
  if (size.width * size.height * 8 > MAX_EXR_DECODE_BYTES) {
    throw new HdrRefusal(
      `${name} is ${size.width} x ${size.height}, more than an OpenEXR can be unpacked whole in memory. ` +
        `Saved as an .hdr it imports, since that is read a line at a time.`,
    );
  }
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
  // Half floats past 512 MB of floats, so a 16k panorama unpacks in half the memory.
  const half = size.width * size.height * 16 > 2 ** 29;
  const parsed = new EXRLoader().setDataType(half ? THREE.HalfFloatType : THREE.FloatType).parse(buf) as unknown as {
    width: number;
    height: number;
    data: ArrayLike<number>;
  };
  const { width, height, data } = parsed;
  if (!data || width * height * 4 > data.length) throw new HdrRefusal(`${name} could not be read as an HDR image.`);
  const f = shrinkFactor(width, maxWidth);
  if (f === 1 && data instanceof Float32Array) {
    flipRows(data, width, height);
    return { width, height, data };
  }
  const read =
    data instanceof Float32Array ? (i: number) => data[i]! : (i: number) => THREE.DataUtils.fromHalfFloat(data[i]!);
  const shrink = new BoxShrink(width, height, f);
  const rgb = new Float32Array(width * 3);
  for (let y = 0; y < height; y++) {
    // EXRLoader hands rows back bottom first.
    const src = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      rgb[x * 3] = read(src + x * 4);
      rgb[x * 3 + 1] = read(src + x * 4 + 1);
      rgb[x * 3 + 2] = read(src + x * 4 + 2);
    }
    shrink.addRow(y, rgb);
  }
  return shrink.finish();
}

/** The pixel size an .hdr or .exr declares, or null when its header is not one. */
export function hdrSize(bytes: Uint8Array, name: string): { width: number; height: number } | null {
  return /\.exr$/i.test(name) ? exrSize(bytes) : radianceSize(bytes);
}

/** Decode an .hdr or .exr into linear floats at most `maxWidth` wide, halved with a box as downscaleEquirect halves.
 *  No file or pixel size is refused. */
export async function decodeHdr(bytes: Uint8Array, name: string, maxWidth = Infinity): Promise<HdrImage> {
  try {
    return /\.exr$/i.test(name) ? await decodeExr(bytes, name, maxWidth) : await decodeRadiance(bytes, name, maxWidth);
  } catch (err) {
    if (err instanceof HdrRefusal) throw err;
    throw new HdrRefusal(
      `${name} could not be read as an HDR image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Halved with a 2 x 2 box until it fits. A box keeps the light's total where
 *  point sampling dropped 15% of a small bright sun. */
export function downscaleEquirect(img: HdrImage, maxWidth: number): HdrImage {
  let cur = img;
  while (cur.width > maxWidth) {
    const w = Math.max(1, cur.width >> 1);
    const h = Math.max(1, cur.height >> 1);
    const out = new Float32Array(w * h * 4);
    const sw = cur.width,
      sh = cur.height,
      s = cur.data;
    for (let y = 0; y < h; y++) {
      const y0 = Math.min(sh - 1, y * 2),
        y1 = Math.min(sh - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(sw - 1, x * 2),
          x1 = Math.min(sw - 1, x * 2 + 1);
        const a = (y0 * sw + x0) * 4,
          b = (y0 * sw + x1) * 4,
          c = (y1 * sw + x0) * 4,
          d = (y1 * sw + x1) * 4;
        const o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) out[o + k] = (s[a + k]! + s[b + k]! + s[c + k]! + s[d + k]!) * 0.25;
      }
    }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}

/** A flat (not run length) Radiance file, which three's loader reads as is. */
export function encodeRgbe(img: HdrImage): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${img.height} +X ${img.width}\n`);
  const n = img.width * img.height;
  const out = new Uint8Array(head.length + n * 4);
  out.set(head);
  let o = head.length;
  for (let i = 0; i < n; i++) {
    const r = Math.max(0, img.data[i * 4]!),
      g = Math.max(0, img.data[i * 4 + 1]!),
      b = Math.max(0, img.data[i * 4 + 2]!);
    const m = Math.max(r, g, b);
    if (!(m > 1e-32) || !Number.isFinite(m)) {
      o += 4;
      continue;
    }
    const e = Math.floor(Math.log2(m)) + 1;
    const s = 256 / 2 ** e;
    out[o++] = Math.min(255, Math.floor(r * s));
    out[o++] = Math.min(255, Math.floor(g * s));
    out[o++] = Math.min(255, Math.floor(b * s));
    out[o++] = e + 128;
  }
  return out;
}

/** Half floats with `gain` applied before the clamp to the largest finite half,
 *  so exposure on a bright sun cannot put Infinity into the PMREM blur. */
export function toHalfRgba(img: HdrImage, gain = 1): Uint16Array {
  const out = new Uint16Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = (i & 3) === 3 ? img.data[i]! : img.data[i]! * gain;
    out[i] = THREE.DataUtils.toHalfFloat(Math.min(65504, v));
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function deflateBase64(bytes: Uint8Array): string {
  const z = zlibSync(bytes, { level: 6 });
  let s = "";
  for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(s);
}

export function inflateBase64(text: string): Uint8Array {
  const bin = atob(text);
  const z = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) z[i] = bin.charCodeAt(i);
  return unzlibSync(z);
}

/** A chrome ball in the panorama, `size` square, RGBA bytes for a canvas: the look the built in rooms' tiles give.
 *  Exposed for the panorama's mean, so a dim interior and a bright sky both read. Directions follow hdrRoom, row 0
 *  at +Z and azimuth -2 pi u from +X; the view looks along +Y. */
export function sphereThumbnailPixels(img: HdrImage, size: number): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, data } = img;
  let sum = 0;
  let weight = 0;
  const step = Math.max(1, Math.floor(h / 64));
  for (let y = 0; y < h; y += step) {
    const sin = Math.sin((Math.PI * (y + 0.5)) / h);
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * sin;
      weight += sin;
    }
  }
  const mean = weight > 0 ? sum / weight : 0;
  const gain = mean > 1e-6 && Number.isFinite(mean) ? Math.min(1e4, 0.4 / mean) : 1;
  const sample = (dx: number, dy: number, dz: number, k: number, out: number[]) => {
    const u = (((Math.atan2(-dy, dx) / (2 * Math.PI)) % 1) + 1) % 1;
    const v = Math.acos(Math.max(-1, Math.min(1, dz))) / Math.PI;
    const sx = Math.min(w - 1, Math.floor(u * w));
    const sy = Math.min(h - 1, Math.floor(v * h));
    const i = (sy * w + sx) * 4;
    for (let c = 0; c < 3; c++) out[c] = Math.max(0, data[i + c]!) * gain * k;
  };
  const out = new Uint8ClampedArray(size * size * 4);
  const radius = 0.78;
  const c = [0, 0, 0];
  const acc = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      acc[0] = acc[1] = acc[2] = 0;
      // 2 x 2 samples a pixel, so the ball's rim is not a staircase.
      for (let sub = 0; sub < 4; sub++) {
        const nx = ((x + 0.25 + 0.5 * (sub & 1)) / size) * 2 - 1;
        const nz = 1 - ((y + 0.25 + 0.5 * (sub >> 1)) / size) * 2;
        const r2 = (nx * nx + nz * nz) / (radius * radius);
        if (r2 < 1) {
          // The ball's normal faces the viewer (-Y); a view ray along +Y reflects off it.
          const ny = -Math.sqrt(1 - r2);
          const d = 2 * ny;
          sample((-d * nx) / radius, 1 - d * ny, (-d * nz) / radius, 0.55 + 0.45 * Math.sqrt(1 - r2), c);
        } else {
          const n = Math.hypot(nx, 1.4, nz);
          sample(nx / n, 1.4 / n, nz / n, 0.35, c);
        }
        for (let k = 0; k < 3; k++) acc[k] = acc[k]! + c[k]! / (1 + c[k]!) / 4;
      }
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = 255 * Math.pow(acc[k]!, 1 / 2.2);
      out[o + 3] = 255;
    }
  }
  return out;
}
