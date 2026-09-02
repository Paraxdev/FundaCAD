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

/** The most turns one drag may reach.
 *
 *  Not the kernel's limit — OCCT will sweep a hundred turns and take its time
 *  doing it. It is a limit on what a HAND can mean: the arrow travels one turn
 *  per trip round the model, so twenty is already a long gesture, and past that
 *  a flick that overshoots costs a rebuild measured in seconds. A spring with
 *  more turns than this is typed, and a typed angle goes through unclamped. */
export const MAX_DRAG_TURNS = 20;

/** The smallest sweep a drag may come to rest on, in degrees. Zero is not a
 *  revolve at all, and the snap step can land exactly on it. Small enough that
 *  dragging back through it and out the other side reverses the sweep without
 *  catching on anything. */
export const MIN_DRAG_ANGLE = 1;

/** Continue a turn past the +/-180 seam.
 *
 *  A cursor's angle about the axis is only ever known to within a full turn, so
 *  a drag that goes all the way round reads +179, then -179, and the sweep
 *  unwinds a whole circle at the moment it should have completed one. This picks
 *  the multiple of 360 that puts `raw` nearest `prev` — right for any hand that
 *  moves less than half a turn between two frames, and a hand moving faster than
 *  that was not aiming at anything in particular.
 *
 *  The move gizmo's rings do NOT need this: they measure from the grab point
 *  afresh every frame and so are capped at half a turn by construction. That is
 *  correct for a rotation, where more than half a turn is better expressed the
 *  short way round, and wrong for a thread, where ten turns is an ordinary
 *  answer and the turns are the thing being counted. */
export function unwrapTurn(prev: number, raw: number): number {
  if (!Number.isFinite(raw)) return prev;
  if (!Number.isFinite(prev)) return raw;
  return raw + 360 * Math.round((prev - raw) / 360);
}

/** Hold a DRAGGED angle to what can actually be built.
 *
 *  The other half of clampDragPitch, and the same rule read from the far end.
 *  Past a full turn, a climb shorter than the profile is tall makes each turn
 *  run into the one before; OCCT builds that quite happily and hands back a
 *  self-intersecting solid, so the sidecar refuses it outright. The pitch arrow
 *  stops at the shortest climb that clears one turn of the last; the angle arrow
 *  stops at the last turn that clears, which for a pitch too small — a flat
 *  revolve very much included — is exactly one.
 *
 *  That wall is the point rather than a guard rail. A hand pulling the sweep
 *  round meets it at the turn where the geometry would begin to collide, so the
 *  limit is found by feel, at the moment of asking for it, instead of being read
 *  off an error afterwards.
 *
 *  `minPitch` of 0 means the profile could not be measured and clamps nothing
 *  but the far cap. Only for the drag: a typed angle goes through and is refused
 *  with a reason, the same asymmetry clampDragPitch keeps. */
export function clampDragAngle(deg: number, pitch: number, minPitch: number): number {
  if (!Number.isFinite(deg)) return MIN_DRAG_ANGLE;
  // A revolve that does not climb at all is capped at one turn whatever the
  // profile measured, because the second turn re-sweeps the solid the first one
  // made: there is nothing past 360 to find, so the arrow should not travel
  // there. That is true without measuring anything, which is why it is checked
  // separately from the collision rule below.
  const flat = Math.abs(pitch) < 1e-9;
  const collides = minPitch > 0 && Math.abs(pitch) < minPitch;
  const cap = 360 * (flat || collides ? 1 : MAX_DRAG_TURNS);
  // `deg < 0` rather than Math.sign, which answers 0 for 0 and would send an
  // angle dragged exactly onto zero out as zero however hard it is clamped.
  const sign = deg < 0 ? -1 : 1;
  return sign * Math.min(cap, Math.max(MIN_DRAG_ANGLE, Math.abs(deg)));
}

/** How many degrees of the sweep circle make an arrow `px` screen pixels long.
 *
 *  Constant SCREEN length, like every other handle, because the arrow has to
 *  stay grabbable on a 200mm flange and on a 2mm thread alike and those differ
 *  by two orders of magnitude in what a pixel is worth in degrees.
 *
 *  Capped, because a small radius or a far zoom would otherwise wrap the arrow
 *  round the axis and back — which reads as a ring, a thing you turn to no
 *  particular end, rather than as a direction the sweep is already going. */
export function arcSpanDeg(
  radius: number,
  mmPerPx: number,
  px: number,
  maxDeg = MAX_ARC_DEG,
): number {
  if (!(radius > 1e-9) || !(mmPerPx > 0) || !Number.isFinite(px)) return maxDeg;
  return Math.min(maxDeg, (Math.abs(px * mmPerPx) / radius) * (180 / Math.PI));
}

/** The widest the angle arrow may open, in degrees. See arcSpanDeg. */
export const MAX_ARC_DEG = 70;

/** A short run of the sweep's OWN circle, continuing forward from where the
 *  sweep currently ends: the track the angle arrow rides.
 *
 *  At the real radius, in the real plane, climbing at the real pitch — not flat
 *  against the screen. The whole claim the arrow makes is "your sweep goes this
 *  way, round here", and a screen-flat arc standing beside the part would be a
 *  widget that happened to be nearby. Climbing matters for the same reason: on a
 *  thread the arrow leaves the last point of the helix along it, rather than
 *  stepping off onto a flat circle the geometry never travels.
 *
 *  `spanDeg` is signed by the caller so the arrow points the way MORE turning
 *  goes, which on a left-hand sweep is the other way round. Empty for the same
 *  inputs screwPath refuses, so the two are offered and withheld together. */
export function sweepArc(
  at: Vec3,
  axis: { origin: Vec3; dir: Vec3 },
  angleDeg: number,
  pitch: number,
  spanDeg: number,
  segments = 12,
): Vec3[] {
  const dir = unit(axis.dir);
  if (!dir) return [];
  const rel = sub(at, axis.origin);
  const axial = dot(rel, dir);
  const radial = sub(rel, mul(dir, axial));
  if (len(radial) < 1e-9) return [];
  const base = add(axis.origin, mul(dir, axial));
  const perTurn = pitch / 360; // rise per DEGREE, so the arc climbs as the helix does
  const n = Math.max(2, Math.floor(segments));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const deg = angleDeg + (spanDeg * i) / n;
    out.push(add(add(base, mul(dir, perTurn * deg)), rotate(radial, dir, (deg * Math.PI) / 180)));
  }
  return out;
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
