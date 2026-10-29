// The zebra stripe coordinate, mirrored line for line by the shader in overlays.ts. All of it is in
// view space, where the viewer looks down -Z in both projections: pan and zoom never move the stripes,
// an orbit turns the model under them.

export type ZebraDirection = "horizontal" | "vertical";
export type Vec3 = readonly [number, number, number];

/** How far the stripe environment wraps around the model, 0 a flat screen, 1 a sphere. Above 0.5 a
 *  flat face seen near grazing loses its stripes, at 0 every flat face shows the same screen stripes. */
export const ZEBRA_LAMBDA = 0.25;

export function zebraAxis(direction: ZebraDirection): Vec3 {
  return direction === "vertical" ? [1, 0, 0] : [0, 1, 0];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The view ray reflected off the surface, with the normal turned to face the viewer first. */
export function zebraReflect(nv: Vec3): Vec3 {
  const len = Math.hypot(nv[0], nv[1], nv[2]) || 1;
  const s = (nv[2] < 0 ? -1 : 1) / len;
  const k = 2 * nv[2] * s;
  return [k * nv[0] * s, k * nv[1] * s, k * nv[2] * s - 1];
}

/** Stripe coordinate in model units at view space point pv with normal nv, centre cv the model's.
 *  The reflected ray meets a stripe environment about reach away, so curvature bends the stripes,
 *  and the position term keeps a flat face striped where its reflection alone is constant. */
export function zebraStripeCoord(pv: Vec3, nv: Vec3, cv: Vec3, direction: ZebraDirection, reach: number): number {
  const a = zebraAxis(direction);
  const r = zebraReflect(nv);
  const d: Vec3 = [pv[0] - cv[0], pv[1] - cv[1], pv[2] - cv[2]];
  return dot(d, a) + dot(r, a) * (reach - ZEBRA_LAMBDA * dot(d, r));
}

export const ZEBRA_WIDTH_MIN = 1;
export const ZEBRA_WIDTH_MAX = 5;
export const ZEBRA_WIDTH_DEFAULT = 3;
const PERIODS_AT_WIDTH_ONE = 30;

// A held frame survives a box whose diagonal stays within this factor of its size and whose centre
// moves less than this share of it, so an edit that nudges the box leaves the stripes where they were.
const REFIT_SCALE = 1.5;
const REFIT_SHIFT = 0.25;

export interface ZebraFrame {
  centre: Vec3;
  size: number;
  reach: number;
  period: number;
}

/** The stripe frame for a model box: its centre, a reach about half its radius, and a stripe period
 *  that fits PERIODS_AT_WIDTH_ONE / width periods along the diagonal. A longer reach packs a fillet
 *  with a comb of stripes too thin to judge. Centre and size come from held while the box fits it. */
export function zebraFrame(min: Vec3, max: Vec3, width: number, held?: ZebraFrame | null): ZebraFrame {
  const w = Number.isFinite(width) ? Math.min(ZEBRA_WIDTH_MAX, Math.max(ZEBRA_WIDTH_MIN, width)) : ZEBRA_WIDTH_DEFAULT;
  let size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  let centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  if (held && fits(held, centre, size)) ({ centre, size } = held);
  return { centre, size, reach: size / 4, period: (size * w) / PERIODS_AT_WIDTH_ONE };
}

function fits(held: ZebraFrame, centre: Vec3, size: number): boolean {
  const shift = Math.hypot(centre[0] - held.centre[0], centre[1] - held.centre[1], centre[2] - held.centre[2]);
  return size <= held.size * REFIT_SCALE && size * REFIT_SCALE >= held.size && shift <= held.size * REFIT_SHIFT;
}
