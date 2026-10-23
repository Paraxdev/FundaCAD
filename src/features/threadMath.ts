// Thread arithmetic for a revolve with a `pitch`, which the kernel sweeps along a helix (builder._screw_revolve).

/** ISO 261 coarse pitches by nominal diameter in mm; coarse is what an unspecified "M6" means. */
const ISO_COARSE: readonly (readonly [number, number])[] = [
  [1.6, 0.35],
  [2, 0.4],
  [2.5, 0.45],
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [20, 2.5],
  [24, 3],
  [30, 3.5],
  [36, 4],
  [42, 4.5],
  [48, 5],
  [56, 5.5],
  [64, 6],
];

/** Nearest size, not next smaller: a shaft measured off a mesh reads 5.9987 or 6.0013 and both are M6.
 *  Outside the table the ratio at the nearest end carries on, so a 100mm bore gets a plausible pitch. */
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

/** ISO 68-1 basic thread height 0.6134·P, major to minor diameter of a 60° external thread. */
export const THREAD_DEPTH_RATIO = 0.6134;

/** Half width of the cutting triangle per pitch. Must stay under 0.5: the kernel refuses a profile
 *  taller than one turn's climb, since OCCT returns a self intersecting solid that measures fine. */
export const THREAD_HALF_WIDTH_RATIO = THREAD_DEPTH_RATIO * Math.tan(Math.PI / 6);

// Breakout past the cylinder, a fraction of thread depth with a floor in mm. An edge ON the cylinder is a
// tangent boolean OCCT does not reliably cut: on a ⌀20 × 2.5 shank 0.01mm removed nothing, 0.25mm cut the thread.
const BREAKOUT_RATIO = 0.15;
const BREAKOUT_FLOOR = 0.02;

/** In the meridian plane the revolve's profile lives in: `x` from the axis, `y` along it from the thread start. */
export interface ProfilePoint {
  x: number;
  y: number;
}

/** `external` is a shank (groove eats inward), else a bore (outward); both are cuts. The caller closes
 *  the three points. Null when the groove would reach the axis, a pitch far too coarse for the diameter. */
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

export function threadAngleDeg(length: number, pitch: number): number {
  if (!(length > 0) || !(pitch > 0)) return 0;
  return round3((length / pitch) * 360);
}

export function threadTurns(length: number, pitch: number): number {
  if (!(length > 0) || !(pitch > 0)) return 0;
  return length / pitch;
}

/** Under one turn there is no helix to see, and a plain revolve beats the climbing sweep. */
export const MIN_THREAD_TURNS = 1;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The groove a core `thread` feature sweeps, as `[into, along]` with `into` from the face into the material:
 *  60 degree flanks, 0.6134P deep, a P/8 root flat, open side broken out past the face. */
export function grooveProfile(radius: number, pitch: number, external: boolean): [number, number][] | null {
  if (!(radius > 0) || !(pitch > 0) || !Number.isFinite(radius) || !Number.isFinite(pitch)) return null;
  const depth = pitch * THREAD_DEPTH_RATIO;
  if (external && depth >= radius - BREAKOUT_FLOOR) return null;
  const tan30 = Math.tan(Math.PI / 6);
  const floor = pitch / 16;
  const breakout = Math.max(BREAKOUT_FLOOR, depth * BREAKOUT_RATIO);
  const out = floor + (depth + breakout) * tan30;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  return [
    [-breakout, -out],
    [depth, -floor],
    [depth, floor],
    [-breakout, out],
  ].map(([a, b]) => [r5(a!), r5(b!)]);
}
