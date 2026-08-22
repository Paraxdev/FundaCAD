// How the camera TRAVELS to a plane, and which side of that plane it arrives on.
//
// Two decisions that used to be one line each and both wrong in a way you only
// notice with the mouse in your hand:
//
//   * the trip was instant. Entering a sketch teleported the view, and a teleport
//     costs the user the one thing an animation gives away for free — that the
//     part did not change, only the vantage did. The stated reason was
//     determinism: camera-controls aborts its own transitions on any input, so a
//     twitch could strand the sketch view at an oblique angle and quietly ruin
//     "draw exactly on the plane". That reason is about ITS transitions. A flight
//     we drive ourselves, over a fixed number of milliseconds, with input off for
//     the duration, lands on exactly the numbers a snap would have.
//
//   * the arrival side was whatever the stored normal happened to be. A plane's
//     normal is a property of the plane, not of where you are looking from, so
//     starting a sketch on the base XY plane while under the part flung the
//     camera through the model to look at it from above. Which side you are ON
//     is the answer the user already gave by orbiting there.
//
// No THREE, no camera, no controls: this is the arithmetic, and cameras.ts is the
// shell that applies it. Same split as viewport/orbitPivot.ts.

export type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Shortest flight, in seconds. Below this a move reads as a cut rather than a
 *  motion and the easing has nowhere to happen. */
export const MIN_FLIGHT_S = 0.18;
/** Longest flight, in seconds. A 180° turn is the worst case; past about this
 *  the animation stops being a courtesy and starts being a wait. */
export const MAX_FLIGHT_S = 0.5;
/** Turns smaller than this (radians, ~1.4°) are not worth animating: the view is
 *  already there, and a flight would only add latency to a Look At that is a
 *  no-op. Snap instead. */
export const SNAP_TURN_RAD = 0.025;

/** How long to spend turning by `turn` radians while the eye distance changes by
 *  a factor of `zoomRatio` (1 = no dolly).
 *
 *  Proportional to the turn, because a 10° correction and a 180° flip taking the
 *  same time makes the small one feel sluggish and the large one feel rushed.
 *  The zoom term matters on its own: entering a sketch on a face you are already
 *  square to still pulls the camera to the standoff distance, and that move is
 *  the whole animation. */
export function flightSeconds(turn: number, zoomRatio: number): number {
  const t = Number.isFinite(turn) ? Math.abs(turn) : 0;
  const r = Number.isFinite(zoomRatio) && zoomRatio > 0 ? zoomRatio : 1;
  // log of the ratio so 2x out and 2x in cost the same, and 10x costs about
  // three times what 2x does rather than five times.
  const zoom = Math.abs(Math.log2(r));
  const want = MIN_FLIGHT_S + (t / Math.PI) * 0.28 + Math.min(zoom, 4) * 0.05;
  return Math.min(MAX_FLIGHT_S, want);
}

/** True when the move is large enough to be worth flying rather than snapping. */
export function worthFlying(turn: number, zoomRatio: number): boolean {
  if (!Number.isFinite(turn) || !Number.isFinite(zoomRatio) || !(zoomRatio > 0)) return false;
  return Math.abs(turn) > SNAP_TURN_RAD || Math.abs(Math.log2(zoomRatio)) > 0.08;
}

/** Ease in and out (smootherstep). Zero velocity at BOTH ends, so the flight
 *  neither jerks off the mark nor arrives with a bump — and, unlike a spring or
 *  a damped follow, it is over at a time we chose rather than asymptotically. */
export function ease(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** `normal`, flipped if need be so it points at `eye` rather than away from it —
 *  the side of the plane the camera is already on.
 *
 *  Grazing views (the eye within `graze` of the plane, relative to the standoff)
 *  keep the normal they were given: at that angle the side is a coin flip, and a
 *  coin flip is the one thing this must not be, because the answer decides which
 *  way a sketch's +X runs and therefore where every coordinate in it lands. */
export function viewSideNormal(
  normal: Vec3,
  eye: Vec3,
  origin: Vec3,
  graze = 1e-6,
): Vec3 {
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

/** Negate without minting -0. Arithmetically the same number, but it reads as a
 *  different one everywhere a normal is printed or compared literally. */
function neg(v: number): number {
  return v === 0 ? 0 : -v;
}
