// Whether a visible sketch's profile area or the body surface under the same
// cursor ray gets the pick in the model view.
//
// The sketch has priority, that is what lets "draw a shape on a face, exit,
// click it, extrude" work. It stops at two places: a body in FRONT of the
// profile hides it, and a profile that traces a whole face is that face as far
// as the user can see, so the face is what the click means.

/** Depth tolerance as a fraction of the model diagonal, the same scale the
 *  picker uses to tell an edge on the near surface from one round the back. */
export const REGION_DEPTH_FRACTION = 0.002;

/** How close the profile's area must be to the face's to count as the same
 *  surface. Both are polygon approximations of the same outline, which differ
 *  by well under a percent. */
export const SAME_AREA_FRACTION = 0.02;

export interface RegionSurfaceTie {
  /** ray distance to the profile area */
  regionDist: number;
  /** ray distance to the nearest body surface, null when the ray misses the model */
  surfaceDist: number | null;
  /** model diagonal, for the depth tolerance */
  modelScale: number;
  /** area of the profile, holes removed */
  regionArea: number;
  /** area of the face the ray hit */
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
