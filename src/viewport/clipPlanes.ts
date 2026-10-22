// Perspective near and far planes. Near is a fraction of the pivot distance, clamped at both ends, so a zoom can reach
// features 0.2mm across; from 2mm out it stays 0.1mm.

/** Near plane for any ordinary view, kept whenever the camera is far enough out. */
export const NEAR_AT_REST = 0.1;

/** 1/20, so the inspected surface has twenty times the near distance in front of it. */
export const NEAR_FRACTION = 0.05;

/** Below a tenth of a micron the geometry is finer than the kernel's own tolerance. */
export const NEAR_FLOOR = 1e-4;

/** In mm. Not closer because vertices reach the GPU as float32: a point 30mm out is stored to about 2e-6 mm, a tenth of
 *  a pixel at this distance, and another decade in would show that quantisation. */
export const MIN_PERSP_DIST = 0.02;

/** Closest approach whatever the coordinates, two microns. */
export const MIN_DISTANCE_FLOOR = 2e-3;

/** One pixel has to span at least ten float32 steps of coordinates up to `maxCoord` (MIN_PERSP_DIST is this for a part
 *  within 30mm of the origin on a 1000px view). */
export function minDistanceFor(maxCoord: number, fovDeg = 45, heightPx = 1000): number {
  const m = Number.isFinite(maxCoord) && maxCoord > 0 ? maxCoord : 0;
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 1000;
  const t = Math.tan(((Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : 45) * Math.PI) / 360);
  const quantum = m * 2 ** -24;
  return Math.max(MIN_DISTANCE_FLOOR, (10 * quantum * h) / (2 * t));
}

/** Half view height in multiples of the bounding radius. The ball then spans a 25th of the view, about 30px, before the
 *  part shrinks to a speck the user loses. */
export const ZOOM_OUT_FACTOR = 25;

/** Zoom-out limit with nothing built, room sized so the grid still reads. */
export const ZOOM_OUT_EMPTY = 5000;

/** So a sketch drawn around a tiny part can still be seen whole: a 2mm cube is 12px across on a 600px view. */
export const ZOOM_OUT_MIN = 50;

/** Nor over this, a kilometre either side of the view centre. */
export const ZOOM_OUT_CEILING = 1e6;

/** Multiples of the radius a fit may need (a tall narrow window), which the
 *  ceiling never cuts under. */
const FIT_ROOM = 12;

export function maxViewHalfHeight(contentRadius: number): number {
  if (!(contentRadius > 0) || !Number.isFinite(contentRadius)) return ZOOM_OUT_EMPTY;
  const r = contentRadius;
  return Math.max(ZOOM_OUT_MIN, Math.min(ZOOM_OUT_CEILING, r * ZOOM_OUT_FACTOR), r * FIT_ROOM);
}

// Zoomed out, a 0.1mm near z-fights: a 24-bit depth buffer resolves z^2 / (near * 2^24), 2.4mm steps at 2m. Near may
// move out to half the eye's gap to the bounds, capped at a hundredth of the pivot distance so the ground is not cut.

/** Near may sit this fraction of the eye's gap to the model's bounds. */
export const NEAR_GAP_FRACTION = 0.5;

/** ...and no further out than this fraction of the pivot distance. */
export const NEAR_DISTANCE_CAP = 0.01;

/** Where to put the near plane with the camera this far from its pivot, and
 *  `gap` from the model's bounding box (0 inside it or with no model). */
export function perspNear(distance: number, gap = 0): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return NEAR_AT_REST;
  const base = Math.min(NEAR_AT_REST, Math.max(NEAR_FLOOR, distance * NEAR_FRACTION));
  if (!(gap > 0) || !Number.isFinite(gap)) return base;
  return Math.max(base, Math.min(gap * NEAR_GAP_FRACTION, distance * NEAR_DISTANCE_CAP));
}

// Far follows the pivot distance like the adaptive grid's reach (measured: a 1000mm cell at 13054mm reaches 37500mm),
// a fixed far cut the grid off. The precision lost past about 1.25m only hits the grid, which writes no depth.

/** Far for any ordinary view, and its floor: a close up must still see the far side of a large part. */
export const FAR_AT_REST = 10000;

/** The grid needs a shade under 4 pivot distances (37500/13054), doubled for a grazing orbited view. */
export const FAR_FACTOR = 8;

export function perspFar(distance: number): number {
  if (!(distance > 0) || !Number.isFinite(distance)) return FAR_AT_REST;
  return Math.max(FAR_AT_REST, distance * FAR_FACTOR);
}

/** Half depths of the orthographic frustum, in half view heights. Depth is linear here, so the range is generous: the
 *  lattice reaches about nine, and 30 leaves room for an angled view. */
export const ORTHO_DEPTH_FACTOR = 30;

export function orthoDepth(halfHeight: number): number {
  if (!(halfHeight > 0) || !Number.isFinite(halfHeight)) return FAR_AT_REST;
  return Math.max(FAR_AT_REST, halfHeight * ORTHO_DEPTH_FACTOR);
}

export interface Clip {
  near: number;
  far: number;
}

/** The content box spans depths [zmin, zmax] along the view axis, NaN without content. Far never cuts the box, and near
 *  moves out toward it only as far as the gap in front allows. */
export function perspClip(distance: number, zmin: number, zmax: number): Clip {
  const gap = Number.isFinite(zmin) && zmin > 0 ? zmin : 0;
  const near = perspNear(distance, gap);
  const reach = Number.isFinite(zmax) && zmax > 0 ? zmax * 1.05 : 0;
  return { near, far: Math.max(perspFar(distance), reach, near * 2) };
}

/** Orthographic clip planes about the eye: the usual depth either side, widened
 *  to hold the whole content box, which can lie behind the eye. */
export function orthoClip(halfHeight: number, zmin: number, zmax: number): Clip {
  const depth = orthoDepth(halfHeight);
  const pad = depth * 0.01;
  const near = Number.isFinite(zmin) ? Math.min(-depth, zmin - pad) : -depth;
  const far = Number.isFinite(zmax) ? Math.max(depth, zmax + pad) : depth;
  return { near, far };
}
