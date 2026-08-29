// Threads, as a cut that climbs.
//
// The kernel already knows how to make one: a revolve with a `pitch` sweeps its
// profile along a helix instead of closing on itself (builder._screw_revolve).
// What was missing was the arithmetic between "this cylindrical face is an M6
// shank" and that feature — the profile's own shape, where it sits, and how far
// round it goes. That is all here, and none of it needs a pointer, so none of it
// is in the tool.
//
// Everything is in the (radial, axial) plane of one meridian: x = distance from
// the axis, y = distance along it from the start of the thread. That is exactly
// the plane the revolve's profile lives in, so these numbers go into a sketch
// unchanged.

/** ISO 261 coarse pitches, by nominal diameter in mm. Coarse rather than fine
 *  because a coarse thread is what an unspecified "M6" means on a drawing, in a
 *  hardware drawer and in a print. */
const ISO_COARSE: readonly (readonly [number, number])[] = [
  [1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1],
  [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [20, 2.5], [24, 3],
  [30, 3.5], [36, 4], [42, 4.5], [48, 5], [56, 5.5], [64, 6],
];

/** The coarse pitch for the nearest nominal size to `diameter`, in mm.
 *
 *  Nearest rather than next-smaller: a shaft measured off a mesh comes back as
 *  5.9987 or 6.0013 and both of those are an M6. Outside the table the ratio at
 *  the nearest end is carried on, so a 100mm bore still gets a plausible pitch
 *  instead of a wrong one. */
export function coarsePitchFor(diameter: number): number {
  if (!(diameter > 0) || !Number.isFinite(diameter)) return 1;
  let best = ISO_COARSE[0]!;
  for (const row of ISO_COARSE) {
    if (Math.abs(row[0] - diameter) < Math.abs(best[0] - diameter)) best = row;
  }
  const first = ISO_COARSE[0]!;
  const last = ISO_COARSE[ISO_COARSE.length - 1]!;
  if (diameter < first[0]) return round3((first[1] * diameter) / first[0]);
  if (diameter > last[0]) return round3((last[1] * diameter) / last[0]);
  return best[1];
}

/** Basic thread height as a fraction of the pitch — ISO 68-1's 0.6134·P, the
 *  distance from the major to the minor diameter of a 60° external thread. */
export const THREAD_DEPTH_RATIO = 0.6134;

/** Half the axial width of the cutting triangle, as a fraction of the pitch:
 *  a 60° included angle over that depth (depth · tan 30°).
 *
 *  It matters that this is UNDER 0.5: the kernel refuses a climbing revolve
 *  whose profile is taller along the axis than one turn's climb, because
 *  consecutive turns would then run into each other and OCCT would hand back a
 *  self-intersecting solid that measures as if nothing were wrong. 0.354 leaves
 *  the flats a real thread has between its turns. */
export const THREAD_HALF_WIDTH_RATIO = THREAD_DEPTH_RATIO * Math.tan(Math.PI / 6);

/** How far the groove's open side is pushed past the cylinder it cuts, as a
 *  fraction of the thread depth (with an absolute floor, in mm, for very fine
 *  pitches).
 *
 *  This has to be a real overlap, not a token one. A profile whose outer edge
 *  sits ON the cylinder is a tangent boolean, and OCCT does not reliably cut
 *  one: measured on a ⌀20 × 2.5 shank, a 0.01mm breakout produced a cut that
 *  came back byte-identical to the shank (no exception, no material removed,
 *  and the no-op guard correctly reporting "Cut removed nothing"), while 0.25mm
 *  produced the thread. The crest of the groove is in fresh air either way, so
 *  the extra reach costs the finished part nothing. */
const BREAKOUT_RATIO = 0.15;
const BREAKOUT_FLOOR = 0.02;

/** One point of the profile, in the meridian plane: `x` from the axis, `y` along
 *  it from the start of the thread. */
export interface ProfilePoint { x: number; y: number }

/** The triangle to sweep, for a thread of `pitch` on a cylinder of `radius`.
 *
 *  `external` says which side the material is on — a shank (material inside the
 *  cylinder, so the groove eats inward) or a bore (material outside, so it eats
 *  outward). Either way the result is a CUT: a thread is what is left after the
 *  groove is removed, which is why one profile serves both.
 *
 *  Returned as three points in order; the caller closes them. Null when the
 *  groove would reach the axis or turn the cylinder inside out, which is what a
 *  pitch far too coarse for the diameter means. */
export function threadProfile(radius: number, pitch: number, external: boolean): ProfilePoint[] | null {
  if (!(radius > 0) || !(pitch > 0) || !Number.isFinite(radius) || !Number.isFinite(pitch)) return null;
  const depth = pitch * THREAD_DEPTH_RATIO;
  const half = pitch * THREAD_HALF_WIDTH_RATIO;
  const breakout = Math.max(BREAKOUT_FLOOR, depth * BREAKOUT_RATIO);
  const apex = external ? radius - depth : radius + depth;
  const base = external ? radius + breakout : radius - breakout;
  if (apex <= breakout || base <= breakout) return null;
  return [
    { x: base, y: -half },
    { x: base, y: half },
    { x: apex, y: 0 },
  ];
}

/** The revolve arc, in degrees, for a thread `length` mm long at this pitch: one
 *  turn per pitch, wound on as far as the thread runs. */
export function threadAngleDeg(length: number, pitch: number): number {
  if (!(length > 0) || !(pitch > 0)) return 0;
  return round3((length / pitch) * 360);
}

/** Turns in a thread of this length — what the readout says, because "6 turns"
 *  is a thing you can count on the part and 2160° is not. */
export function threadTurns(length: number, pitch: number): number {
  if (!(length > 0) || !(pitch > 0)) return 0;
  return length / pitch;
}

/** Shortest thread worth building: under one turn there is no helix to see, and
 *  the kernel's climbing sweep is only better than a plain revolve past it. */
export const MIN_THREAD_TURNS = 1;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
