// Where an emissive body or face puts its light, and how bright that light is.
//
// Pure numbers, kept out of viewport.ts so they can be tested without a scene.
// The viewport owns the THREE.PointLight objects and the rank-and-cap budget;
// this decides what each of them should be.

/** Light reach, in emitter sizes. A neighbour a few sizes away is lit, the far
 *  side of the model is not washed. */
export const EMITTER_REACH = 8;

/** Irradiance at one emitter size away, per unit of glow, as a multiple of the
 *  key light's 2.0. Measured in the app (bloom off, default studio): the old
 *  per-diagonal gain put a 12mm lamp's pool below one grey level on the floor
 *  20mm under it; this makes the same lamp throw a pool you see from across the
 *  room without blowing out the part beside it. */
export const EMITTER_LIGHT_GAIN = 16;

/** How bright an emitter's point light is. It scales with the emitter's AREA
 *  (size squared), not its diagonal: the scene is in millimetres and the light
 *  falls off with the square of the distance, so a gain on the diagonal made a
 *  small part a light no surface could see, and a big one no brighter per mm.
 *  With size squared, the light one emitter size away reads the same whatever
 *  the emitter measures, which is what "this is a lamp" means at any scale. */
export function emitterIntensity(glow: number, size: number): number {
  return glow * EMITTER_LIGHT_GAIN * size * size;
}

export function emitterReach(size: number): number {
  return size * EMITTER_REACH;
}

/** How far a FACE's light sits in front of the face. On the surface itself, half
 *  of the light went into the body and the face's own triangles sat on the shadow
 *  camera's near plane. Half the shadow near distance clears both, and stays
 *  small against the face so the pool still starts at the face. */
export function emitterStandoff(size: number): number {
  return Math.max(size * 0.05, 0.25);
}

export function emitterShadowNear(size: number): number {
  return Math.max(size * 0.1, 0.5);
}

export interface FaceEmitterShape {
  /** Where the light goes: the face's area weighted centroid, lifted along its
   *  average normal until it clears the face's own surface by emitterStandoff. */
  position: [number, number, number];
  normal: [number, number, number];
  /** The face's bounding box diagonal. */
  size: number;
}

/** One shape per glowing face of a body mesh, walked once over its triangles.
 *
 *  `index` is the mesh's index buffer. Bodies are indexed, so triangle t's
 *  corners are index[3t..3t+2] and NOT vertices 3t..3t+2; reading them as the
 *  latter put every face light at some other face's vertices. Pass null only for
 *  a mesh that really is a triangle soup. */
export function faceEmitterShapes(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  faceIds: ArrayLike<number>,
  glowing: (fid: number) => boolean,
): Map<number, FaceEmitterShape> {
  const acc = new Map<number, { c: number[]; n: number[]; area: number; min: number[]; max: number[] }>();
  const at = (t: number, k: number) => (index ? index[t * 3 + k]! : t * 3 + k) * 3;
  for (let t = 0; t < faceIds.length; t++) {
    const fid = faceIds[t]!;
    if (!glowing(fid)) continue;
    let a = acc.get(fid);
    if (!a) {
      a = { c: [0, 0, 0], n: [0, 0, 0], area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      acc.set(fid, a);
    }
    const i0 = at(t, 0), i1 = at(t, 1), i2 = at(t, 2);
    const ux = positions[i1]! - positions[i0]!, uy = positions[i1 + 1]! - positions[i0 + 1]!, uz = positions[i1 + 2]! - positions[i0 + 2]!;
    const vx = positions[i2]! - positions[i0]!, vy = positions[i2 + 1]! - positions[i0 + 1]!, vz = positions[i2 + 2]! - positions[i0 + 2]!;
    // The cross product is twice the area along the winding normal, so summing
    // it area weights the normal and its length weights the centroid.
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const w = Math.hypot(cx, cy, cz);
    a.n[0]! += cx; a.n[1]! += cy; a.n[2]! += cz;
    a.area += w;
    for (const i of [i0, i1, i2]) {
      for (let d = 0; d < 3; d++) {
        const p = positions[i + d]!;
        a.c[d]! += (p * w) / 3;
        if (p < a.min[d]!) a.min[d] = p;
        if (p > a.max[d]!) a.max[d] = p;
      }
    }
  }
  const shapes = new Map<number, { c: number[]; normal: [number, number, number]; size: number; bulge: number }>();
  for (const [fid, a] of acc) {
    if (a.area <= 0) continue;
    const size = Math.hypot(a.max[0]! - a.min[0]!, a.max[1]! - a.min[1]!, a.max[2]! - a.min[2]!) || 1;
    const nl = Math.hypot(a.n[0]!, a.n[1]!, a.n[2]!);
    // A closed face (a whole sphere) has normals that cancel: no side to lift the
    // light towards, so it stays at the centre.
    const normal: [number, number, number] = nl > a.area * 1e-3
      ? [a.n[0]! / nl, a.n[1]! / nl, a.n[2]! / nl]
      : [0, 0, 0];
    shapes.set(fid, { c: a.c.map((v) => v / a.area), normal, size, bulge: 0 });
  }
  // How far the face stands proud of its own centroid along that normal. A flat
  // face is 0; a domed lens has its centroid well inside the dome, and a light
  // left there would sit inside the body behind its own surface.
  for (let t = 0; t < faceIds.length; t++) {
    const s = shapes.get(faceIds[t]!);
    if (!s) continue;
    for (let k = 0; k < 3; k++) {
      const i = at(t, k);
      const along = (positions[i]! - s.c[0]!) * s.normal[0] + (positions[i + 1]! - s.c[1]!) * s.normal[1]
        + (positions[i + 2]! - s.c[2]!) * s.normal[2];
      if (along > s.bulge) s.bulge = along;
    }
  }
  const out = new Map<number, FaceEmitterShape>();
  for (const [fid, s] of shapes) {
    const lift = s.bulge + emitterStandoff(s.size);
    out.set(fid, {
      position: [0, 1, 2].map((d) => s.c[d]! + s.normal[d]! * lift) as [number, number, number],
      normal: s.normal,
      size: s.size,
    });
  }
  return out;
}
