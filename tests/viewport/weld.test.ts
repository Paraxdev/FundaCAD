// The textured-body weld moved from a string key per vertex to a numeric hash.
// Same vertices, same order, same indices, on a mesh the size of the faceted
// texture that took 357 ms to weld.

import { describe, expect, it } from "vitest";
import { weldByFace } from "../../src/viewport/weld";

/** The string-keyed weld as render.ts had it, kept as the reference. */
function weldByString(
  localPositions: Float32Array,
  localNormals: Float32Array,
  localIndices: Uint32Array,
  localFaceIds: number[],
) {
  const q = 1e4;
  const seen = new Map<string, number>();
  const wp: number[] = [];
  const wn: number[] = [];
  for (let t = 0; t < localIndices.length; t++) {
    const v = localIndices[t]!;
    const fid = localFaceIds[(t / 3) | 0]!;
    const b = v * 3;
    const key = `${Math.round(localPositions[b]! * q)},${Math.round(localPositions[b + 1]! * q)},`
      + `${Math.round(localPositions[b + 2]! * q)}|${Math.round(localNormals[b]! * 1e3)},`
      + `${Math.round(localNormals[b + 1]! * 1e3)},${Math.round(localNormals[b + 2]! * 1e3)}|${fid}`;
    let nv = seen.get(key);
    if (nv === undefined) {
      nv = wp.length / 3;
      seen.set(key, nv);
      wp.push(localPositions[b]!, localPositions[b + 1]!, localPositions[b + 2]!);
      wn.push(localNormals[b]!, localNormals[b + 1]!, localNormals[b + 2]!);
    }
    localIndices[t] = nv;
  }
  return { positions: Float32Array.from(wp), normals: Float32Array.from(wn) };
}

/** A de-indexed faceted heightfield, 3 fresh vertices per triangle with its
 *  own flat normal, the way the engine ships a textured face. Four faces, one
 *  per quadrant, so the border vertices must NOT merge across them; a planar
 *  strip, so coplanar neighbours DO merge; knurl-like bumps everywhere else. */
function facetedMesh(grid: number, origin = 0) {
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const h = new Float64Array((grid + 1) * (grid + 1));
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      h[j * (grid + 1) + i] = i < grid / 5 ? 0.3 * i + 0.1 * j : Math.sin(i * 0.9) * Math.cos(j * 0.7) * 0.4 + rand() * 0.05;
    }
  }
  const nTri = grid * grid * 2;
  const positions = new Float32Array(nTri * 9);
  const normals = new Float32Array(nTri * 9);
  const faceIds: number[] = new Array(nTri);
  const pt = (i: number, j: number) => [origin + i * 0.25, origin + j * 0.25, h[j * (grid + 1) + i]!] as const;
  let t = 0;
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[], fid: number) => {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const [k, p] of [a, b, c].entries()) {
      const o = t * 9 + k * 3;
      positions[o] = p[0]!; positions[o + 1] = p[1]!; positions[o + 2] = p[2]!;
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
    }
    faceIds[t++] = fid;
  };
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const fid = (i < grid / 2 ? 0 : 1) + (j < grid / 2 ? 0 : 2);
      tri(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), fid);
      tri(pt(i, j), pt(i + 1, j + 1), pt(i, j + 1), fid);
    }
  }
  const indices = new Uint32Array(nTri * 3);
  for (let k = 0; k < indices.length; k++) indices[k] = k;
  return { positions, normals, indices, faceIds };
}

/** Element by element, as the string key saw values: NaN equals NaN. A plain
 *  toEqual on arrays this size runs for seconds. */
function mismatches(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let bad = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && !(a[i] !== a[i] && b[i] !== b[i])) bad++;
  return bad;
}

function best(run: () => void): number {
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    run();
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
}

describe("weldByFace", () => {
  it("welds a 169k triangle faceted texture exactly as the string key did", () => {
    const m = facetedMesh(291); // 169,362 triangles
    expect(m.faceIds.length).toBeGreaterThan(169_000);
    const refIdx = m.indices.slice();
    const ref = weldByString(m.positions, m.normals, refIdx, m.faceIds);
    const idx = m.indices.slice();
    const out = weldByFace(m.positions, m.normals, idx, m.faceIds);

    expect(out.positions.length).toBe(ref.positions.length);
    expect(mismatches(out.positions, ref.positions)).toBe(0);
    expect(mismatches(out.normals, ref.normals)).toBe(0);
    expect(mismatches(idx, refIdx)).toBe(0);
    // it did weld something, and did not weld everything
    expect(ref.positions.length / 3).toBeLessThan(m.indices.length);
    expect(ref.positions.length / 3).toBeGreaterThan(m.indices.length / 6);

    const oldMs = best(() => weldByString(m.positions, m.normals, m.indices.slice(), m.faceIds));
    const newMs = best(() => weldByFace(m.positions, m.normals, m.indices.slice(), m.faceIds));
    console.log(`weld of ${m.faceIds.length} triangles: string key ${oldMs.toFixed(1)} ms, numeric hash ${newMs.toFixed(1)} ms`);
  }, 60_000);

  it("keeps a face border unwelded and far coordinates distinct", () => {
    // 300 m out, where a 0.1µm bucket no longer fits in 32 bits
    const m = facetedMesh(40, 300_000);
    const refIdx = m.indices.slice();
    const ref = weldByString(m.positions, m.normals, refIdx, m.faceIds);
    const idx = m.indices.slice();
    const out = weldByFace(m.positions, m.normals, idx, m.faceIds);
    expect(mismatches(out.positions, ref.positions)).toBe(0);
    expect(mismatches(out.normals, ref.normals)).toBe(0);
    expect(mismatches(idx, refIdx)).toBe(0);
  });

  it("treats -0 as 0 and NaN as one value, as the string key did", () => {
    const positions = Float32Array.from([0, 0, 0, -0, -0, -0, NaN, 1, 1, NaN, 1, 1]);
    const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const mk = () => Uint32Array.from([0, 1, 2, 3, 2, 1]);
    const refIdx = mk();
    const ref = weldByString(positions, normals, refIdx, [7, 7]);
    const idx = mk();
    const out = weldByFace(positions, normals, idx, [7, 7]);
    expect(idx).toEqual(refIdx);
    expect(out.positions.length).toBe(ref.positions.length);
  });
});
