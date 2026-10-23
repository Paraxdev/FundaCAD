// The helix a climbing revolve's profile travels; the engine sweeps along the same curve (builder.py _screw_revolve).
// The angle's sign sets which way it turns and the pitch's which way it climbs, independently: four different solids.

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

export function unit(a: Vec3): Vec3 | null {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

/** `axis` is both the field of record for a world axis and the resolved line cache beside a picked edge, so no
 *  resolving is needed. No direction falls back to Z, as the engine does. */
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

/** Pitch is per turn, so this is the one place the two are related. */
export function riseOf(angleDeg: number, pitch: number): number {
  return turnsOf(angleDeg) * pitch;
}

/** The hand moves a rise, the document records a pitch. Null for zero turns rather than an infinity for the kernel. */
export function pitchFromRise(rise: number, angleDeg: number): number | null {
  const turns = turnsOf(angleDeg);
  return turns === 0 ? null : rise / turns;
}

/** Past a full turn a climb shorter than the profile collides with the last turn, and OCCT returns a self-intersecting
 *  solid that measures fine, so the drag stops there. 0 stays reachable; typed values are refused with a reason.
 *  A `minPitch` of 0 means not measured and clamps nothing. */
export function clampDragPitch(pitch: number, minPitch: number, angleDeg: number): number {
  if (!(minPitch > 0) || Math.abs(turnsOf(angleDeg)) <= 1) return pitch;
  if (Math.abs(pitch) < 1e-9) return 0;
  return Math.abs(pitch) < minPitch ? minPitch * Math.sign(pitch) : pitch;
}

/** A limit on what a hand can mean, not the kernel's: past it an overshoot costs seconds. More turns are typed. */
export const MAX_DRAG_TURNS = 20;

/** Degrees. Zero is not a revolve, and the snap step can land exactly on it. */
export const MIN_DRAG_ANGLE = 1;

/** Picks the multiple of 360 nearest `prev`, right for a hand moving under half a turn per frame. The move gizmo's
 *  rings stop at half a turn by construction, but a thread counts its turns. */
export function unwrapTurn(prev: number, raw: number): number {
  if (!Number.isFinite(raw)) return prev;
  if (!Number.isFinite(prev)) return raw;
  return raw + 360 * Math.round((prev - raw) / 360);
}

/** The far end of clampDragPitch's rule: stops at the last turn that clears, exactly one for a flat revolve, so the
 *  limit is found by feel. `minPitch` 0 clamps only the far cap; a typed angle goes through. */
export function clampDragAngle(deg: number, pitch: number, minPitch: number): number {
  if (!Number.isFinite(deg)) return MIN_DRAG_ANGLE;
  // A flat revolve caps at one turn whatever was measured, since the second turn re-sweeps the first.
  const flat = Math.abs(pitch) < 1e-9;
  const collides = minPitch > 0 && Math.abs(pitch) < minPitch;
  const cap = 360 * (flat || collides ? 1 : MAX_DRAG_TURNS);
  // `deg < 0`, not Math.sign, which answers 0 for 0 and would send an angle dragged onto zero out as zero.
  const sign = deg < 0 ? -1 : 1;
  return sign * Math.min(cap, Math.max(MIN_DRAG_ANGLE, Math.abs(deg)));
}

/** Constant screen length, so the arrow stays grabbable on a 200mm flange and a 2mm thread alike. Capped, or a small
 *  radius would wrap it round into a ring. */
export function arcSpanDeg(radius: number, mmPerPx: number, px: number, maxDeg = MAX_ARC_DEG): number {
  if (!(radius > 1e-9) || !(mmPerPx > 0) || !Number.isFinite(px)) return maxDeg;
  return Math.min(maxDeg, (Math.abs(px * mmPerPx) / radius) * (180 / Math.PI));
}

/** The widest the angle arrow may open, in degrees. See arcSpanDeg. */
export const MAX_ARC_DEG = 70;

/** On the real circle, plane and pitch, continuing from where the sweep ends so the arrow leaves the helix along it.
 *  `spanDeg` is signed by the caller; empty for the inputs screwPath refuses. */
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

/** Capped so a hundred-turn spring cannot push thousands of vertices through a per-frame rebuild. */
export function helixSegments(angleDeg: number, perTurn = 16, max = 2000): number {
  const n = Math.ceil(Math.abs(turnsOf(angleDeg)) * perTurn);
  return Math.max(2, Math.min(max, n));
}

/** Starts at `at`, any point of the profile; a point on the axis returns nothing, as the engine refuses it. The
 *  last point is the sweep's end, where the handle stands. */
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
