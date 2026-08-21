// The arithmetic behind the direct-manipulation edge gesture: a drag along the
// handle's axis into a radius/distance, the flip between the two edge treatments
// mid-gesture, and the bounds that keep the number buildable.
//
// The drag is SIGNED, and that is the design: one axis carries both treatments with
// "nothing" at the origin between them. Drag the way the arrow points for a fillet,
// keep pulling back through the origin and the same travel becomes a chamfer's
// setback, stop at the origin and there is no feature. Changing your mind costs a
// mouse movement rather than an abort and a restart — which is what the earlier
// one-sided drag, floored at a snap step, forced on you.
//
// Split out of edgeFeatureTool.ts because the tool is pointer plumbing that cannot
// run headless, and these are the functions that can be wrong in a way a user
// notices.

import { snap } from "../ui/units";

export type EdgeTreatment = "fillet" | "chamfer";

export interface TreatmentField {
  /** the Feature field the value is stored in (mm) */
  name: "radius" | "distance";
  /** the one-letter label on the heads-up input */
  label: "R" | "D";
}

export interface ValueBounds {
  min: number;
  max: number;
}

/** Smallest value worth committing, in mm. Below this OCCT either refuses or
 *  produces a blend nobody can see — so it is both the floor for a TYPED value
 *  and, for a dragged one, the test for "the user is sitting on the origin and
 *  has asked for no feature at all". */
export const MIN_EDGE_VALUE = 0.001;

/** How much of the model's bounding-box diagonal a dragged value may reach.
 *
 *  A runaway guard, not a judgement. It exists to stop a flick of the mouse from
 *  running the number to 10⁴ mm and firing a string of doomed rebuilds; the
 *  KERNEL decides what actually builds, and blendCeiling below carries that
 *  answer back into the drag. Half the diagonal is past a full round on a cube
 *  (s/2 ≈ 0.29 of s·√3), so nothing a blend can legitimately reach is behind it.
 *
 *  It used to be a quarter, and it used to be replaced outright by the measured
 *  neighbourhood clearance (features/blendClearance.ts), which made that
 *  measurement a WALL. A distance to the nearest neighbouring edge cannot decide
 *  what OCCT will build — its own module says so — and used that way it stopped
 *  a drag at 0.11 mm on a part that blends happily at twenty times that. The
 *  clearance now sizes the OPENING value only, which is the job it can do.
 *
 *  Typed values are deliberately not clamped by any of this. */
export const MAX_DIAGONAL_FRACTION = 0.5;

export function treatmentField(kind: EdgeTreatment): TreatmentField {
  return kind === "fillet" ? { name: "radius", label: "R" } : { name: "distance", label: "D" };
}

export function otherTreatment(kind: EdgeTreatment): EdgeTreatment {
  return kind === "fillet" ? "chamfer" : "fillet";
}

/** Human name for prompts and the gizmo readout. */
export function treatmentLabel(kind: EdgeTreatment): string {
  return kind === "fillet" ? "Fillet" : "Chamfer";
}

/** How far a dragged value may travel from the origin, in mm — the same cap on
 *  BOTH sides, since a chamfer that overruns the face is no more buildable than
 *  a fillet that does. Infinity when the document has no geometry to measure. */
export function dragLimit(modelDiagonal: number | null): number {
  if (modelDiagonal == null || !(modelDiagonal > 0) || !Number.isFinite(modelDiagonal)) {
    return Infinity;
  }
  return Math.max(MIN_EDGE_VALUE, modelDiagonal * MAX_DIAGONAL_FRACTION);
}

/** Bounds for a value the user is free to choose outright (a typed one, or one
 *  carried across a Tab flip): anything the kernel might build, floored at the
 *  smallest visible blend. */
export function valueBounds(modelDiagonal: number | null): ValueBounds {
  return { min: MIN_EDGE_VALUE, max: dragLimit(modelDiagonal) };
}

/** What the kernel has said about size so far, during ONE gesture on ONE set of
 *  edges. Reset whenever either of those changes. */
export interface BlendRange {
  /** the largest size seen to build that is below every refusal, or null */
  built: number | null;
  /** the smallest size the kernel refused, or null */
  refused: number | null;
  /** some size built at all — the evidence that SIZE is what decides here */
  anyBuilt: boolean;
}

export const EMPTY_BLEND_RANGE: BlendRange = { built: null, refused: null, anyBuilt: false };

/** Fold one kernel answer into the range.
 *
 *  A refusal is the later word about `value` than any success at the same size,
 *  so it drops a `built` that has caught up with it. That case is real, not
 *  defensive: rebuilds coalesce, so a build begun at the previous size lands
 *  while the drag is already showing the next one, and both get recorded against
 *  it. Left in, the wall would sit exactly ON the refused size — the drag parked
 *  on a value that shows no blend, which is the behaviour all of this replaces.
 *
 *  `anyBuilt` never comes back off, because it answers a different question: not
 *  "how big" but "is size what decides here at all". */
export function noteBlendOutcome(range: BlendRange, value: number, built: boolean): BlendRange {
  if (!Number.isFinite(value) || value <= 0) return range;
  if (!built) {
    const refused = range.refused == null ? value : Math.min(range.refused, value);
    return {
      built: range.built != null && range.built >= refused ? null : range.built,
      refused,
      anyBuilt: range.anyBuilt,
    };
  }
  const below = range.refused == null || value < range.refused;
  return {
    built: below ? Math.max(range.built ?? 0, value) : range.built,
    refused: range.refused,
    anyBuilt: true,
  };
}

/** The wall the kernel itself has put in front of the drag. Infinity while
 *  nothing has been refused: until then there is no measured wall and the
 *  runaway guard is the only bound.
 *
 *  The wall sits one `step` BELOW the refusal, not on it — one step down is the
 *  largest size the drag can hold that is actually there. A `built` above that
 *  raises it back: a refusal can describe a size the drag has already left. */
export function blendCeiling(range: BlendRange, step: number): number {
  const { built, refused, anyBuilt } = range;
  if (refused == null || !Number.isFinite(refused) || refused <= 0) return Infinity;
  // Nothing has built at any size, so nothing says SIZE is what is wrong. Plenty
  // of blends fail identically however small they get — a tangent edge has no
  // corner to cut, a chain with nowhere to end fails the same at a twentieth of
  // the value — and walling the drag off a refusal like that would invent a
  // limit out of a failure that has none in it.
  if (!anyBuilt) return Infinity;
  const back = Number.isFinite(step) && step > 0 ? step : MIN_EDGE_VALUE;
  const wall = Math.max(MIN_EDGE_VALUE, refused - back);
  return built != null && Number.isFinite(built) && built > wall ? built : wall;
}

export function clampValue(v: number, bounds: ValueBounds): number {
  if (!Number.isFinite(v)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, v));
}

export interface Scrub {
  /** signed offset in mm when the handle was grabbed (see scrubSigned) */
  grabSigned: number;
  /** axis projection (mm) at grab time */
  grabProj: number;
  /** axis projection (mm) now */
  proj: number;
  /** snap granularity in mm */
  step: number;
  /** largest magnitude the drag may reach, either side of the origin */
  limit: number;
}

/** Signed offset for the current pointer position: where the drag started plus
 *  how far the cursor has travelled along the handle's axis, snapped to a clean
 *  step so the readout says 2.5 rather than 2.4713, then held inside ±limit.
 *  Relative to the grab (not absolute along the axis) so taking hold of the
 *  handle never makes the value jump.
 *
 *  Exactly 0 inside a one-step dead zone around the origin. Snapping alone would
 *  already produce 0 within half a step, but half a step is ~4 px of mouse
 *  travel — too fine a target for a state the user has to be able to stop in on
 *  purpose, since it is how the gesture is abandoned. A whole step either side
 *  makes the origin a detent you can feel, and the first value past it is one
 *  clean increment rather than a jump. */
export function scrubSigned(s: Scrub): number {
  const raw = s.grabSigned + (s.proj - s.grabProj);
  if (!Number.isFinite(raw)) return 0;
  const dead = s.step > 0 && Number.isFinite(s.step) ? s.step : MIN_EDGE_VALUE;
  if (Math.abs(raw) < dead) return 0;
  const stepped = snap(raw, s.step);
  const limit = s.limit > 0 ? s.limit : Infinity;
  return Math.sign(stepped) * Math.min(Math.abs(stepped), limit);
}

/** Read a signed offset as a treatment: `positive` is the one the arrow's own
 *  direction means, its opposite lives on the other side of the origin, and the
 *  magnitude is the radius or setback either way.
 *
 *  A radius and a setback are the same drag off the same edge, which is why one
 *  axis can carry both — the sign is the only thing that distinguishes them. At
 *  exactly 0 the value is 0 and the reported kind is arbitrary; callers keep
 *  showing whichever they had rather than let the label flicker at the
 *  crossing. */
export function treatmentAt(
  positive: EdgeTreatment,
  signed: number,
): { kind: EdgeTreatment; value: number } {
  return {
    kind: signed < 0 ? otherTreatment(positive) : positive,
    value: Math.abs(signed),
  };
}

/** Flip fillet ↔ chamfer in place, carrying the number across untouched — what
 *  Tab does, and the only way to switch a value that was TYPED rather than
 *  dragged (a typed number has no side of the origin to be on).
 *
 *  Re-clamped only because the caller may hand us a value from a different
 *  bounds regime (a typed one, or one dragged before the camera zoomed). */
export function switchTreatment(
  kind: EdgeTreatment,
  value: number,
  bounds: ValueBounds,
): { kind: EdgeTreatment; value: number } {
  return { kind: otherTreatment(kind), value: clampValue(value, bounds) };
}

/** Opening value for a gesture that starts from a command rather than from the
 *  handle — the tool has to show SOMETHING the moment it arms. (A gesture that
 *  starts by grabbing the handle opens at 0 instead: there the drag itself is
 *  the value, measured from where you pressed.)
 *
 *  A 2 mm fillet / 1 mm chamfer is the familiar MCAD default, held down to what
 *  the picked edges' own neighbourhood plausibly holds (blendClearance.ts) and
 *  then to the drag bounds — a default nobody can build is worse than a small
 *  one. This is the whole of the clearance measurement's job: it is a good guess
 *  at where to open, and it was never able to be the wall it used to be. */
export function seedValue(
  kind: EdgeTreatment,
  bounds: ValueBounds,
  localLimit?: number | null,
): number {
  const want = kind === "fillet" ? 2 : 1;
  const local =
    localLimit != null && Number.isFinite(localLimit) && localLimit > 0 ? localLimit : Infinity;
  return clampValue(Math.min(want, local), bounds);
}
