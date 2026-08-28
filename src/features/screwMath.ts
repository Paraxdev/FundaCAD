// The path a climbing revolve's profile travels: a helix, in plain numbers.
//
// One arithmetic, used twice. The tool draws this curve while you drag the pitch
// arrow, and the sidecar sweeps the profile along the same curve to build the
// thread (sidecar/builder.py, _screw_revolve). If the two disagree, the dashed
// line on screen is a lie about where the geometry is going, which is worse than
// drawing nothing: a preview is believed.
//
// No THREE and no viewport here, so the sign conventions can be pinned down in
// vitest. They need pinning: the angle decides which way the sweep turns and the
// pitch decides which way it climbs, INDEPENDENTLY, and each of the four
// combinations is a different solid.

import type { AxisSpec, Vec3 } from "../types";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Unit vector, or null when there is no direction to be had. */
export function unit(a: Vec3): Vec3 | null {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

/** The line a revolve turns about, in world space.
 *
 *  A revolve's `axis` is the field of record for one of the three world axes AND
 *  the resolved-line cache written beside a picked edge, so reading it answers
 *  both without resolving anything. A spec that names no direction at all falls
 *  back to Z, which is what the sidecar does with the same input. */
export function revolveAxis(spec: AxisSpec): { origin: Vec3; dir: Vec3 } {
  if (typeof spec === "string") {
    const dir: Vec3 = [spec === "X" ? 1 : 0, spec === "Y" ? 1 : 0, spec === "Z" ? 1 : 0];
    return { origin: [0, 0, 0], dir: unit(dir) ?? [0, 0, 1] };
  }
  const o = (spec.origin ?? [0, 0, 0]) as Vec3;
  const d = (spec.dir ?? [0, 0, 1]) as Vec3;
  return { origin: [o[0], o[1], o[2]], dir: unit([d[0], d[1], d[2]]) ?? [0, 0, 1] };
}

/** Turns, signed: which way round it goes is the angle's sign. */
export function turnsOf(angleDeg: number): number {
  return angleDeg / 360;
}

/** How far the far end of the sweep stands above where the profile was drawn.
 *  Pitch is per TURN, so this is the one place the two are related. */
export function riseOf(angleDeg: number, pitch: number): number {
  return turnsOf(angleDeg) * pitch;
}

/** The pitch that would put the end of the sweep `rise` above the profile.
 *  The inverse of riseOf, and what a drag on the end of the thread means: the
 *  hand moves a rise, the document records a pitch. Zero turns has no answer,
 *  and says so rather than returning an infinity that would reach the kernel. */
export function pitchFromRise(rise: number, angleDeg: number): number | null {
  const turns = turnsOf(angleDeg);
  return turns === 0 ? null : rise / turns;
}

/** Hold a DRAGGED pitch to what can actually be built.
 *
 *  Past a full turn, a climb shorter than the profile is tall makes every turn
 *  run into the one before; OCCT builds that quite happily and hands back a
 *  self-intersecting solid that measures as though nothing were wrong, so the
 *  sidecar refuses it outright. The arrow stops there instead, which is what a
 *  hand on a handle expects.
 *
 *  Zero stays reachable, because zero is the flat revolve rather than a bad
 *  thread. `minPitch` of 0 means "not measured" and clamps nothing.
 *
 *  Only for the drag. A pitch somebody TYPED goes through untouched and is
 *  refused with a reason: silently rewriting a deliberate number is worse than
 *  saying why it will not work. */
export function clampDragPitch(pitch: number, minPitch: number, angleDeg: number): number {
  if (!(minPitch > 0) || Math.abs(turnsOf(angleDeg)) <= 1) return pitch;
  if (Math.abs(pitch) < 1e-9) return 0;
  return Math.abs(pitch) < minPitch ? minPitch * Math.sign(pitch) : pitch;
}

/** Rotate `v` about the unit axis `k` by `rad` (Rodrigues). */
function rotate(v: Vec3, k: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/** How many points to draw a helix of `turns` with. Enough to look round, and
 *  capped so a hundred-turn spring cannot put thousands of vertices through a
 *  per-frame rebuild. */
export function helixSegments(angleDeg: number, perTurn = 16, max = 2000): number {
  const n = Math.ceil(Math.abs(turnsOf(angleDeg)) * perTurn);
  return Math.max(2, Math.min(max, n));
}

/** The profile's path: from where it was drawn, round by `angleDeg`, climbing
 *  `pitch` every turn.
 *
 *  `at` is any point of the profile (its recorded interior anchor will do). The
 *  curve starts THERE, which is what makes it readable as "this is where your
 *  section goes" rather than as an abstract spiral near the part. A point on the
 *  axis has no meridian to start from and returns nothing, the same refusal the
 *  sidecar makes for the same reason.
 *
 *  The LAST point is the end of the sweep, and so the place to stand a handle:
 *  taking it from here rather than computing it again is what keeps the arrow on
 *  the curve it is stretching. */
export function screwPath(
  at: Vec3,
  axis: { origin: Vec3; dir: Vec3 },
  angleDeg: number,
  pitch: number,
  segments = helixSegments(angleDeg),
): Vec3[] {
  const dir = unit(axis.dir);
  if (!dir) return [];
  const rel = sub(at, axis.origin);
  const axial = dot(rel, dir);
  const radial = sub(rel, mul(dir, axial));
  if (len(radial) < 1e-9) return [];
  const base = add(axis.origin, mul(dir, axial));
  const rise = riseOf(angleDeg, pitch);
  const rad = (angleDeg * Math.PI) / 180;
  const n = Math.max(2, Math.floor(segments));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(add(add(base, mul(dir, rise * t)), rotate(radial, dir, rad * t)));
  }
  return out;
}
