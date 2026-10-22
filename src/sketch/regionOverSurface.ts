// Whether a visible sketch's profile or the body surface under the same cursor ray gets the pick. The sketch wins
// unless a body is in front of it, or the profile traces a whole face, which the user sees as that face.

/** Depth tolerance as a fraction of the model diagonal, the scale the picker uses for near and far edges. */
export const REGION_DEPTH_FRACTION = 0.002;

/** Profile and face areas this close count as one surface, both are polygon approximations of one outline. */
export const SAME_AREA_FRACTION = 0.02;

export interface RegionSurfaceTie {
  regionDist: number;
  /** null when the ray misses the model */
  surfaceDist: number | null;
  /** model diagonal */
  modelScale: number;
  /** holes removed */
  regionArea: number;
  faceArea: number;
}

export function regionBeatsSurface(t: RegionSurfaceTie): boolean {
  if (t.surfaceDist == null || !Number.isFinite(t.surfaceDist)) return true;
  const scale = Number.isFinite(t.modelScale) && t.modelScale > 0 ? t.modelScale : 0;
  const tol = Math.max(1e-6, scale * REGION_DEPTH_FRACTION);
  if (t.surfaceDist < t.regionDist - tol) return false;
  if (t.surfaceDist > t.regionDist + tol) return true;
  if (!(t.faceArea > 0)) return true;
  return Math.abs(t.regionArea - t.faceArea) > t.faceArea * SAME_AREA_FRACTION;
}
