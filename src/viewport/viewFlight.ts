// The arithmetic of camera flights, cameras.ts applies it. A flight we drive with input off lands exactly
// where a snap would, and it arrives on the side of the plane the user already orbited to.

export type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Below this a move reads as a cut rather than a motion. */
export const MIN_FLIGHT_S = 0.18;
/** A 180° turn is the worst case, past this the animation becomes a wait. */
export const MAX_FLIGHT_S = 0.5;
/** About 1.4°, smaller turns snap rather than fly. */
export const SNAP_TURN_RAD = 0.025;

/** Proportional to the turn so a small correction is not sluggish. The zoom term counts alone:
 *  entering a sketch square to a face still dollies to the standoff. `zoomRatio` 1 is no dolly. */
export function flightSeconds(turn: number, zoomRatio: number): number {
  const t = Number.isFinite(turn) ? Math.abs(turn) : 0;
  const r = Number.isFinite(zoomRatio) && zoomRatio > 0 ? zoomRatio : 1;
  // log2 so 2x out and 2x in cost the same, and 10x costs about three times what 2x does.
  const zoom = Math.abs(Math.log2(r));
  const want = MIN_FLIGHT_S + (t / Math.PI) * 0.28 + Math.min(zoom, 4) * 0.05;
  return Math.min(MAX_FLIGHT_S, want);
}

export function worthFlying(turn: number, zoomRatio: number): boolean {
  if (!Number.isFinite(turn) || !Number.isFinite(zoomRatio) || !(zoomRatio > 0)) return false;
  return Math.abs(turn) > SNAP_TURN_RAD || Math.abs(Math.log2(zoomRatio)) > 0.08;
}

/** Smootherstep: zero velocity at both ends, and unlike a spring it ends at a chosen time. */
export function ease(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** `normal` flipped to point at `eye`. A grazing view keeps the given normal, there the side is a
 *  coin flip and it decides which way a sketch's +X runs. */
export function viewSideNormal(normal: Vec3, eye: Vec3, origin: Vec3, graze = 1e-6): Vec3 {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12)) return normal;
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];
  const away: Vec3 = [eye[0] - origin[0], eye[1] - origin[1], eye[2] - origin[2]];
  const reach = Math.hypot(away[0], away[1], away[2]);
  if (!(reach > 1e-12)) return normal;
  const side = dot(n, away) / reach; // cosine of the angle off the plane
  if (Math.abs(side) < graze) return normal;
  return side < 0 ? [neg(normal[0]), neg(normal[1]), neg(normal[2])] : normal;
}

/** Never mints -0, which reads differently wherever a normal is printed or compared literally. */
function neg(v: number): number {
  return v === 0 ? 0 : -v;
}
