// Welds a de-indexed body mesh back into shared vertices, see buildBodyMesh in
// render.ts for when and why it runs.

/** Position buckets of 0.1µm, normal buckets of 1e-3 on the unit vector. */
const POS_Q = 1e4;
const NRM_Q = 1e3;
const KEY = 7;

/** Merges the vertices of `indices` that share a quantised position, a
 *  quantised normal AND a face id, rewriting `indices` in place to the welded
 *  numbering. Vertices are numbered in first-use order along `indices`, so the
 *  result is the same one a string key per vertex gave, at a fraction of the
 *  cost. `faceIds` is per triangle. */
export function weldByFace(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  faceIds: ArrayLike<number>,
): { positions: Float32Array; normals: Float32Array } {
  const n = indices.length;
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  // slot -> welded vertex + 1, 0 is empty
  const table = new Int32Array(size);
  // Doubles rather than int32: a quantised position in 0.1µm overflows 32 bits
  // past about 214 m, and the string key this replaces never did.
  let keys = new Float64Array(Math.min(n, 1 << 14) * KEY);
  const outP = new Float32Array(n * 3);
  const outN = new Float32Array(n * 3);
  let count = 0;
  for (let t = 0; t < n; t++) {
    const v = indices[t]!;
    const b = v * 3;
    const k0 = Math.round(positions[b]! * POS_Q);
    const k1 = Math.round(positions[b + 1]! * POS_Q);
    const k2 = Math.round(positions[b + 2]! * POS_Q);
    const k3 = Math.round(normals[b]! * NRM_Q);
    const k4 = Math.round(normals[b + 1]! * NRM_Q);
    const k5 = Math.round(normals[b + 2]! * NRM_Q);
    const k6 = faceIds[(t / 3) | 0]!;
    let h = 0x811c9dc5;
    h = Math.imul(h ^ (k0 | 0), 0x01000193);
    h = Math.imul(h ^ (k1 | 0), 0x01000193);
    h = Math.imul(h ^ (k2 | 0), 0x01000193);
    h = Math.imul(h ^ (k3 | 0), 0x01000193);
    h = Math.imul(h ^ (k4 | 0), 0x01000193);
    h = Math.imul(h ^ (k5 | 0), 0x01000193);
    h = Math.imul(h ^ (k6 | 0), 0x01000193);
    h ^= h >>> 15;
    let slot = h & mask;
    let found = -1;
    for (;;) {
      const e = table[slot]!;
      if (e === 0) break;
      const o = (e - 1) * KEY;
      if (
        same(keys[o]!, k0) && same(keys[o + 1]!, k1) && same(keys[o + 2]!, k2)
        && same(keys[o + 3]!, k3) && same(keys[o + 4]!, k4) && same(keys[o + 5]!, k5)
        && same(keys[o + 6]!, k6)
      ) {
        found = e - 1;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (found < 0) {
      found = count++;
      table[slot] = found + 1;
      const o = found * KEY;
      if (o + KEY > keys.length) {
        const grown = new Float64Array(Math.min(n * KEY, keys.length * 2));
        grown.set(keys);
        keys = grown;
      }
      keys[o] = k0; keys[o + 1] = k1; keys[o + 2] = k2;
      keys[o + 3] = k3; keys[o + 4] = k4; keys[o + 5] = k5; keys[o + 6] = k6;
      const w = found * 3;
      outP[w] = positions[b]!; outP[w + 1] = positions[b + 1]!; outP[w + 2] = positions[b + 2]!;
      outN[w] = normals[b]!; outN[w + 1] = normals[b + 1]!; outN[w + 2] = normals[b + 2]!;
    }
    indices[t] = found;
  }
  return { positions: outP.slice(0, count * 3), normals: outN.slice(0, count * 3) };
}

/** Key equality as the string key saw it: -0 is 0 and NaN is NaN. */
function same(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}
