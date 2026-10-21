// BLAKE2b with a 16 byte digest, the name the engine's blob store gives a blob
// (crates/fundacad-geom/src/import/blobstore.rs). Neither Node nor the browser
// ships it: Node's blake2b512 fixes the digest length in the parameter block,
// so a truncated 512 bit digest is a different hash.
//
// Each 64 bit word is a (lo, hi) pair in a Uint32Array.

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
].map((row) => row.map((i) => i * 2));

const v = new Uint32Array(32);
const m = new Uint32Array(32);

function add(a: number, b: number) {
  const lo = v[a]! + v[b]!;
  v[a + 1] = v[a + 1]! + v[b + 1]! + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

function addM(a: number, i: number) {
  const lo = v[a]! + m[i]!;
  v[a + 1] = v[a + 1]! + m[i + 1]! + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

function g(a: number, b: number, c: number, d: number, x: number, y: number) {
  add(a, b);
  addM(a, x);
  let lo = v[d]! ^ v[a]!;
  let hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = hi;
  v[d + 1] = lo;
  add(c, d);
  lo = v[b]! ^ v[c]!;
  hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (lo >>> 24) ^ (hi << 8);
  v[b + 1] = (hi >>> 24) ^ (lo << 8);
  add(a, b);
  addM(a, y);
  lo = v[d]! ^ v[a]!;
  hi = v[d + 1]! ^ v[a + 1]!;
  v[d] = (lo >>> 16) ^ (hi << 16);
  v[d + 1] = (hi >>> 16) ^ (lo << 16);
  add(c, d);
  lo = v[b]! ^ v[c]!;
  hi = v[b + 1]! ^ v[c + 1]!;
  v[b] = (hi >>> 31) ^ (lo << 1);
  v[b + 1] = (lo >>> 31) ^ (hi << 1);
}

function compress(h: Uint32Array, block: Uint8Array, t: number, last: boolean) {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i]!;
    v[i + 16] = IV[i]!;
  }
  v[24] = v[24]! ^ (t >>> 0);
  v[25] = v[25]! ^ Math.floor(t / 0x100000000);
  if (last) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  for (let i = 0; i < 32; i++) {
    const o = i * 4;
    m[i] = block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24);
  }
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]!;
    g(0, 8, 16, 24, s[0]!, s[1]!);
    g(2, 10, 18, 26, s[2]!, s[3]!);
    g(4, 12, 20, 28, s[4]!, s[5]!);
    g(6, 14, 22, 30, s[6]!, s[7]!);
    g(0, 10, 20, 30, s[8]!, s[9]!);
    g(2, 12, 22, 24, s[10]!, s[11]!);
    g(4, 14, 16, 26, s[12]!, s[13]!);
    g(6, 8, 18, 28, s[14]!, s[15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 16]!;
}

/** The 32 hex digit blob name of `data`. */
export function blake2b128Hex(data: Uint8Array): string {
  const outlen = 16;
  const h = new Uint32Array(IV);
  h[0] = h[0]! ^ 0x01010000 ^ outlen;
  const block = new Uint8Array(128);
  let t = 0;
  let off = 0;
  while (data.length - off > 128) {
    t += 128;
    compress(h, data.subarray(off, off + 128), t, false);
    off += 128;
  }
  block.fill(0);
  block.set(data.subarray(off));
  t += data.length - off;
  compress(h, block, t, true);
  let hex = "";
  for (let i = 0; i < outlen; i++) {
    const byte = (h[i >> 2]! >>> (8 * (i & 3))) & 0xff;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
