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

/** A 4096 x 2048 panorama measured 34 MB as RGBE, 300 ms to parse and 67 MB as
 *  half floats; past twice that the parse alone freezes the app for seconds. */
export const MAX_HDR_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_HDR_WIDTH = 8192;
/** Kept and embedded at this width; lighting reads a quarter of the pixels. */
export const STORED_HDR_WIDTH = 2048;
/** One texel per texel of the 256 cube face the room is rendered into. */
export const LIGHTING_HDR_WIDTH = 1024;

export class HdrRefusal extends Error {}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

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
    return end < bytes.length ? { text: new TextDecoder("latin1").decode(bytes.subarray(at, end)), next: end + 1 } : null;
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
      const [x0, y0, x1, y1] = [0, 4, 8, 12].map((o) => view.getInt32(body + o, true)) as [number, number, number, number];
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

function refuseSize(name: string, width: number, height: number) {
  if (width > MAX_HDR_WIDTH || height > MAX_HDR_WIDTH) {
    throw new HdrRefusal(`${name} is ${width} x ${height}, an environment can be ${MAX_HDR_WIDTH} pixels wide at most.`);
  }
  if (width < 2 || height < 1) throw new HdrRefusal(`${name} has no pixels.`);
}

/** Decode an .hdr or .exr into linear floats, refusing anything too big before
 *  its pixels are allocated. */
export async function decodeHdr(bytes: Uint8Array, name: string): Promise<HdrImage> {
  if (bytes.length > MAX_HDR_FILE_BYTES) {
    throw new HdrRefusal(`${name} is ${mb(bytes.length)}, an environment file can be ${mb(MAX_HDR_FILE_BYTES)} at most.`);
  }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  type Parsed = { width: number; height: number; data: ArrayLike<number> };
  let parsed: Parsed | null = null;
  const isExr = /\.exr$/i.test(name);
  try {
    if (isExr) {
      const size = exrSize(bytes);
      if (!size) throw new HdrRefusal(`${name} is not an OpenEXR image.`);
      refuseSize(name, size.width, size.height);
      const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
      parsed = new EXRLoader().setDataType(THREE.FloatType).parse(buf) as unknown as Parsed;
    } else {
      const size = radianceSize(bytes);
      if (!size) throw new HdrRefusal(`${name} is not a Radiance HDR image.`);
      refuseSize(name, size.width, size.height);
      const { HDRLoader } = await import("three/examples/jsm/loaders/HDRLoader.js");
      parsed = new HDRLoader().setDataType(THREE.FloatType).parse(buf) as unknown as Parsed;
    }
  } catch (err) {
    if (err instanceof HdrRefusal) throw err;
    throw new HdrRefusal(`${name} could not be read as an HDR image: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed?.data || parsed.width * parsed.height * 4 > parsed.data.length) {
    throw new HdrRefusal(`${name} could not be read as an HDR image.`);
  }
  const data = parsed.data instanceof Float32Array ? parsed.data : Float32Array.from(parsed.data);
  if (isExr) flipRows(data, parsed.width, parsed.height);
  return { width: parsed.width, height: parsed.height, data };
}

/** Halved with a 2 x 2 box until it fits. A box keeps the light's total where
 *  point sampling dropped 15% of a small bright sun. */
export function downscaleEquirect(img: HdrImage, maxWidth: number): HdrImage {
  let cur = img;
  while (cur.width > maxWidth) {
    const w = Math.max(1, cur.width >> 1);
    const h = Math.max(1, cur.height >> 1);
    const out = new Float32Array(w * h * 4);
    const sw = cur.width, sh = cur.height, s = cur.data;
    for (let y = 0; y < h; y++) {
      const y0 = Math.min(sh - 1, y * 2), y1 = Math.min(sh - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(sw - 1, x * 2), x1 = Math.min(sw - 1, x * 2 + 1);
        const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
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
    const r = Math.max(0, img.data[i * 4]!), g = Math.max(0, img.data[i * 4 + 1]!), b = Math.max(0, img.data[i * 4 + 2]!);
    const m = Math.max(r, g, b);
    if (!(m > 1e-32) || !Number.isFinite(m)) { o += 4; continue; }
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

/** A small tone mapped picture of the panorama, RGBA bytes for a canvas. */
export function thumbnailPixels(img: HdrImage, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) / h) * img.height));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) / w) * img.width));
      const i = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = img.data[i + k]!;
        out[o + k] = 255 * Math.pow(v / (1 + v), 1 / 2.2);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
